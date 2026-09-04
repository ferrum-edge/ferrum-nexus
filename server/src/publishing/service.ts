/**
 * Publishing — the bridge between "a provider uploaded a spec" and "a proxy
 * exists on the gateway".
 *
 * ## The Edge object graph behind one published API
 *
 * ```
 * apis row ─── proxy  name `nexus-<slug>`, listen_path `/<ns>/<slug>`
 *               │      allowed_methods, backend_*_timeout_ms, circuit_breaker,
 *               │      allowed_ws_origins — settings on the proxy itself
 *               │
 *               │  proxy.plugins[] ── the association list; this is what makes
 *               │                     a config run at all
 *               ├─ plugin_config    the auth plugin (key_auth | basic_auth | jwt_auth)
 *               ├─ plugin_config    access_control, only when `requestable`
 *               ├─ plugin_config    rate_limiting, only when a rate limit is set
 *               ├─ plugin_config    cors, only when a CORS policy is set
 *               ├─ plugin_config    openapi_validator, only in `routes` mode
 *               └─ plugin_config    one per `api_plugins` row — the provider
 *                                   plugin palette, managed by
 *                                   `plugins/service.ts`
 * ```
 *
 * The `openapi_validator` is the one config generated from the *spec* rather
 * than from a setting on the row, so it is regenerated whenever either input
 * moves: a new spec revision, and a CORS change (which decides whether
 * path-scoped `OPTIONS` operations are generated). See `spec-enforcement.ts`
 * for what the generated config does and — just as importantly — does not
 * enforce.
 *
 * ## Two settings are not free-standing
 *
 * `allowed_methods` and `allowed_ws_origins` live on the proxy but are partly
 * *derived from the CORS policy*, because Edge evaluates them before, and
 * independently of, the `cors` plugin:
 *
 * - a method outside `allowed_methods` is `405`ed **before any plugin runs**,
 *   so the list written to the gateway carries `OPTIONS` whenever the API has a
 *   CORS policy, or every browser preflight would fail;
 * - the `cors` plugin does not run on a WebSocket upgrade at all, and an
 *   HTTP proxy on Edge accepts upgrades on the same listen path, so the CORS
 *   origins are mirrored into `allowed_ws_origins` as the CSWSH check.
 *
 * The `apis` row stores the provider's own method list and nothing for the WS
 * origins; both derivations are recomputed whenever either input changes.
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
 * That machinery — `mutateProxy`, `attach`, `associate`/`disassociate`, the
 * undo steps and `reconcileOptionalPlugin` — lives in
 * [edge-plugins.ts](./edge-plugins.ts), shared with the provider plugin palette
 * (`plugins/service.ts`) so both drive the gateway through one implementation
 * and, crucially, one per-proxy lock.
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

import { isDeepStrictEqual } from 'node:util';

import {
  ACCESS_CONTROL_PLUGIN,
  CREDENTIAL_TYPE_FOR_PLUGIN,
  DEFAULT_BACKEND_CONNECT_TIMEOUT_MS,
  DEFAULT_BACKEND_READ_TIMEOUT_MS,
  DEFAULT_BACKEND_WRITE_TIMEOUT_MS,
  DEFAULT_SPEC_ENFORCEMENT,
  RATE_LIMIT_PLUGIN,
  aclGroupForApi,
  listenPathFor,
  roleAtLeast,
  testConsumerUsername,
  type Api,
  type ApiSpecSummary,
  type ApiStats,
  type ApiStatus,
  type ApiTimeouts,
  type AuthPluginType,
  type CorsConfig,
  type CreateTestConsumerResponse,
  type HttpMethod,
  type Paginated,
  type PublishApiRequest,
  type RateLimitConfig,
  type SpecEnforcementLevel,
  type UpdateApiRequest,
  type Uuid,
} from '@ferrum-nexus/shared';

import { AuditAction, type AuditService } from '../audit/service.js';
import type { EdgeRateLimitSyncConfig, NexusConfig } from '../config/index.js';
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
  EdgeCircuitBreakerConfig,
  EdgePluginConfig,
  EdgePluginSettings,
  EdgeProxy,
} from '../ferrum-admin/types.js';
import { conflict, forbidden, notFound, specInvalid, validationFailed } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import type { NotificationsService } from '../notifications/service.js';
import { createEdgePluginBinder } from './edge-plugins.js';
import { presentApi, type GatewayUrlSource } from './present.js';
import {
  assertUpstreamAllowed,
  formatUpstreamUrl,
  parseOpenApiSpec,
  parseUpstreamUrl,
  resolveUpstream,
  slugify,
  type SpecPath,
  type SpecUpstream,
  type UpstreamPolicy,
} from './oas.js';
import { OPENAPI_VALIDATOR_PLUGIN, validatorConfigFor } from './spec-enforcement.js';

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
  list(actor: UserRecord, filter?: ApiListFilter, options?: ListOptions): Promise<Paginated<Api>>;
  /** One API with its current spec metadata and request/grant counters. */
  get(
    actor: UserRecord,
    apiId: Uuid,
  ): Promise<{ api: Api; spec: ApiSpecSummary | null; stats: ApiStats }>;
  /** Validate the spec, build the Edge objects, then persist the rows. */
  publish(owner: UserRecord, input: PublishApiRequest, ip?: string | null): Promise<PublishResult>;
  /** Change safe runtime settings; reconciles the Edge plugin configs. */
  update(actor: UserRecord, apiId: Uuid, patch: UpdateApiRequest, ip?: string | null): Promise<Api>;
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
  /** Resolves the gateway origin each returned API's `invoke_url` is built from. */
  settings: GatewayUrlSource;
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
export function rateLimitConfig(
  rateLimit: RateLimitConfig,
  sync: EdgeRateLimitSyncConfig,
): EdgePluginSettings {
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
    // Only stamped in `redis` mode. `local` is Edge's own default, and sending
    // it explicitly would pin a value the portal cannot otherwise express while
    // adding two keys (`redis_url` is *required* alongside `sync_mode: redis`)
    // that must not appear at all in the local case.
    ...(sync.syncMode === 'redis' && sync.redisUrl !== undefined
      ? { sync_mode: 'redis', redis_url: sync.redisUrl, redis_tls: sync.redisTls }
      : {}),
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

/**
 * Config for `openapi_validator`, or `null` when the API is `docs_only`.
 *
 * The two inputs beyond the enforcement level are the document's declared
 * paths and the CORS policy, which is why this is recomputed on a spec upload
 * and on a CORS change and not only when the level itself moves.
 *
 * @throws NexusError `SPEC_INVALID` when `routes` is asked for but the document
 * declares no operation to enforce. Edge refuses an empty `operations` array,
 * so the only alternatives are a row claiming enforcement the gateway is not
 * doing, or a proxy that rejects every request — both worse than refusing.
 */
export function openapiValidatorConfig(
  enforcement: SpecEnforcementLevel,
  paths: SpecPath[],
  listenPath: string,
  cors: CorsConfig | null,
): EdgePluginSettings | null {
  if (enforcement !== 'routes') return null;
  const config = validatorConfigFor(paths, listenPath, { hasCors: cors !== null });
  if (!config) {
    throw specInvalid(
      "OpenAPI enforcement is set to 'routes', but the document declares no operations for the " +
        'gateway to allow; add a path with at least one method, or set the enforcement level back ' +
        "to 'docs_only'",
      { field: 'spec_enforcement', reason: 'no_operations' },
    );
  }
  return config;
}

/* ── Proxy runtime settings ─────────────────────────────────────────────── */

/**
 * Edge's own `CircuitBreakerConfig` defaults, written verbatim whenever the
 * provider turns the breaker on.
 *
 * Every field has a serde default, so `{}` would also be accepted — but a proxy
 * document that spells its thresholds out is one an operator can read, and
 * pinning them means a gateway upgrade that moved a default cannot silently
 * change the failure policy of an already-published API. The portal deliberately
 * offers no way to tune them: that is an operator's decision, made on the proxy.
 */
export const DEFAULT_CIRCUIT_BREAKER: EdgeCircuitBreakerConfig = {
  failure_threshold: 5,
  success_threshold: 3,
  timeout_seconds: 30,
  failure_status_codes: [500, 502, 503, 504],
  half_open_max_requests: 1,
  trip_on_connection_errors: true,
};

/**
 * The proxy's `allowed_methods` as it must reach the gateway.
 *
 * Edge rejects a method outside the list with `405` **before any plugin runs**,
 * including the `cors` plugin. A CORS policy is therefore only real if the
 * browser's `OPTIONS` preflight survives long enough to reach it, so the list
 * written to the gateway carries `OPTIONS` whenever the API has a CORS policy —
 * while the `apis` row keeps the provider's own list, so removing CORS later
 * removes the implied `OPTIONS` with it.
 */
export function proxyAllowedMethods(
  methods: HttpMethod[] | null,
  cors: CorsConfig | null,
): HttpMethod[] | null {
  if (methods === null) return null;
  if (cors === null || methods.includes('OPTIONS')) return methods;
  return [...methods, 'OPTIONS'];
}

/**
 * The proxy's `allowed_ws_origins`, derived from the API's CORS policy.
 *
 * Edge treats WebSocket as transparent on an `http(s)` proxy, so publishing an
 * HTTP API also publishes WS on the same listen path — and the `cors` plugin
 * does **not** run on an upgrade. `allowed_ws_origins` is the separate origin
 * check that does, and its default (`[]`) is "no check at all", which is
 * Cross-Site WebSocket Hijacking waiting to happen.
 *
 * A provider who named the browser origins allowed to call the API has already
 * expressed the answer, so the same list is mirrored here. Anything that is not
 * a plain `scheme://host[:port]` origin — `*`, or one of Edge's wildcard/
 * `StringMatch` forms — is dropped, because the WS check is an exact,
 * case-insensitive string comparison and a pattern would silently never match.
 * No CORS policy, or a wildcard one, means `[]`: an API deliberately open to
 * every browser origin gains nothing from a WS allow-list, and a half-populated
 * one would be worse than none.
 */
export function wsOriginsFor(cors: CorsConfig | null): string[] {
  if (cors === null) return [];
  if (cors.allowed_origins.includes('*')) return [];
  return cors.allowed_origins.filter((origin) =>
    /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^*\s]+$/.test(origin),
  );
}

/** The proxy fields the three timeout settings map onto. */
function timeoutFields(timeouts: ApiTimeouts | null): Record<string, number> {
  return {
    backend_connect_timeout_ms: timeouts?.connect_ms ?? DEFAULT_BACKEND_CONNECT_TIMEOUT_MS,
    backend_read_timeout_ms: timeouts?.read_ms ?? DEFAULT_BACKEND_READ_TIMEOUT_MS,
    backend_write_timeout_ms: timeouts?.write_ms ?? DEFAULT_BACKEND_WRITE_TIMEOUT_MS,
  };
}

/**
 * What each proxy setting reverts to when the provider clears it.
 *
 * Used by the undo step: `PUT /proxies/{id}` echoes the document the preceding
 * `GET` returned, so a field the gateway did not report has to be restored to
 * the gateway's documented default rather than left `undefined`, which the
 * whole-resource replace would drop.
 */
const PROXY_SETTING_DEFAULTS: Readonly<Record<string, unknown>> = {
  allowed_methods: null,
  allowed_ws_origins: [],
  circuit_breaker: null,
  ...timeoutFields(null),
};

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

/**
 * Declared paths of an already-stored revision, or `[]` when it can no longer
 * be parsed — the same tolerance {@link safeDefaultUpstream} applies, for the
 * same reason.
 *
 * An empty result is not silently ignored: {@link openapiValidatorConfig}
 * turns it into a `SPEC_INVALID`, so switching enforcement on for an API whose
 * stored document no longer parses fails loudly instead of recording a level
 * the gateway is not enforcing.
 */
function safeSpecPaths(rawSpec: string): SpecPath[] {
  try {
    return parseOpenApiSpec(rawSpec).paths;
  } catch {
    return [];
  }
}

/* ── Service ────────────────────────────────────────────────────────────── */

/** Build the publishing service. */
export function createPublishingService(deps: PublishingServiceDeps): PublishingService {
  const { config, store, edge, audit, notifications, credentials, settings } = deps;
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

  // Every gateway write below goes through the shared binder: the GET-merge-PUT
  // under a per-proxy lock, the create-then-associate pairing, and the undo
  // steps all live in `edge-plugins.ts` so the palette service drives Edge
  // through exactly the same code.
  const binder = createEdgePluginBinder(edge);
  const {
    attach,
    associate,
    disassociate,
    mutateProxy,
    reconcileOptionalPlugin,
    undoAttach,
    undoRemoval,
  } = binder;

  /** Every plugin config attached to the API's proxy, or `[]` when unpublished. */
  async function pluginsOf(api: ApiRecord): Promise<EdgePluginConfig[]> {
    return binder.listByProxy(api.ferrum_proxy_id);
  }

  function findPlugin(plugins: EdgePluginConfig[], name: string): EdgePluginConfig | undefined {
    return binder.find(plugins, name);
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

    async list(actor, filter = {}, options): Promise<Paginated<Api>> {
      const isAdmin = roleAtLeast(actor.role, 'admin');
      // A provider only ever sees their own APIs; `mine` is the admin's opt-in.
      const owner = !isAdmin || filter.mine ? actor.id : filter.owner_user_id;
      const storeFilter: ApiFilter = {
        ...(owner !== undefined ? { owner_user_id: owner } : {}),
        ...(filter.status !== undefined ? { status: filter.status } : {}),
        ...(filter.q !== undefined ? { q: filter.q } : {}),
      };
      const [page, gatewayUrl] = await Promise.all([
        store.apis.list(storeFilter, options),
        settings.getGatewayPublicUrl(),
      ]);
      return { ...page, items: page.items.map((row) => presentApi(row, gatewayUrl)) };
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
        api: presentApi(api, await settings.getGatewayPublicUrl()),
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

      // Resolved once: the proxy body, the `apis` row and the audit row must all
      // agree, and `allowed_methods` is the provider's list *plus* the `OPTIONS`
      // a CORS policy implies — only on the gateway, never on the row.
      const cors = input.cors ?? null;
      const methods = input.allowed_methods ?? null;
      const allowedMethods = proxyAllowedMethods(methods, cors);
      const timeouts = input.timeouts ?? null;
      const circuitBreaker = input.circuit_breaker ?? false;
      const specEnforcement = input.spec_enforcement ?? DEFAULT_SPEC_ENFORCEMENT;
      // Built before the first gateway write: a document with nothing to
      // enforce must fail the request outright, not halfway through creating a
      // proxy that would then have to be rolled back.
      const validator = openapiValidatorConfig(specEnforcement, parsed.paths, listenPath, cors);

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
            // The runtime settings go on at creation rather than in a later
            // `PUT`: they are part of what the API *is*, and a proxy that spent
            // even one round trip accepting every method or with no timeout
            // ceiling would be live in a shape the portal never promised.
            ...(allowedMethods !== null ? { allowed_methods: allowedMethods } : {}),
            ...(timeouts !== null ? timeoutFields(timeouts) : {}),
            ...(circuitBreaker ? { circuit_breaker: DEFAULT_CIRCUIT_BREAKER } : {}),
            allowed_ws_origins: wsOriginsFor(cors),
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
            rateLimitConfig(input.rate_limit, config.edge.rateLimit),
            owner.id,
          );
          created.pluginIds.push(limiter.id);
        }
        if (cors) {
          const corsPlugin = await attach(proxy.id, CORS_PLUGIN, corsPluginConfig(cors), owner.id);
          created.pluginIds.push(corsPlugin.id);
        }
        if (validator) {
          const enforcer = await attach(proxy.id, OPENAPI_VALIDATOR_PLUGIN, validator, owner.id);
          created.pluginIds.push(enforcer.id);
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
            cors,
            // The provider's own list, without the CORS-implied `OPTIONS`.
            allowed_methods: methods,
            timeouts,
            circuit_breaker: circuitBreaker,
            spec_enforcement: specEnforcement,
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
          cors,
          allowed_methods: methods,
          timeouts,
          circuit_breaker: circuitBreaker,
          spec_enforcement: specEnforcement,
          upstream: `${upstream.scheme}://${upstream.host}:${upstream.port}`,
          spec_paths: parsed.pathCount,
          spec_operations: parsed.operationCount,
        },
        ip,
      );

      return {
        api: presentApi(api, await settings.getGatewayPublicUrl()),
        spec: specSummary(spec),
      };
    },

    async update(actor, apiId, patch, ip = null): Promise<Api> {
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
            patch.rate_limit === null
              ? null
              : rateLimitConfig(patch.rate_limit, config.edge.rateLimit),
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

        // ── OpenAPI enforcement ─────────────────────────────────────────
        // The validator config is generated from three inputs; this PATCH can
        // move two of them. The level decides whether the plugin exists at all,
        // and the CORS policy decides whether the browser's `OPTIONS` preflight
        // is declared for each documented path. Without those operations,
        // adding CORS to a `routes` API would make every preflight a `400`. The
        // third input is the document, which `updateSpec` owns.
        const nextEnforcement = patch.spec_enforcement ?? api.spec_enforcement;
        const enforcementMoved =
          patch.spec_enforcement !== undefined && patch.spec_enforcement !== api.spec_enforcement;
        if (
          proxyId &&
          (enforcementMoved || (patch.cors !== undefined && nextEnforcement === 'routes'))
        ) {
          const corsAfterPatch = patch.cors === undefined ? api.cors : patch.cors;
          const current = await store.apiSpecs.findCurrentByApi(api.id);
          await reconcileOptionalPlugin(
            proxyId,
            findPlugin(plugins, OPENAPI_VALIDATOR_PLUGIN),
            OPENAPI_VALIDATOR_PLUGIN,
            openapiValidatorConfig(
              nextEnforcement,
              current ? safeSpecPaths(current.raw_spec) : [],
              listenPathFor(api.namespace, api.slug),
              corsAfterPatch,
            ),
            actor.id,
            undo,
          );
        }
        // Guarded on the proxy like every other gateway-backed field: without
        // one there is nothing to attach the validator to, and recording a level
        // the gateway is not enforcing would make the portal claim something
        // untrue.
        if (proxyId && enforcementMoved && patch.spec_enforcement !== undefined) {
          update.spec_enforcement = patch.spec_enforcement;
          changed.push('spec_enforcement');
          details.spec_enforcement = patch.spec_enforcement;
        }

        // ── Proxy runtime settings ──────────────────────────────────────
        // One read-modify-write for all of them, and only for the ones this
        // PATCH actually addresses: `undefined` leaves a setting alone,
        // including whatever an operator set on the proxy by hand, while
        // `null` writes the gateway's documented default back explicitly —
        // `PUT` echoes the `GET`, so "reset" is a value, not an omission.
        //
        // Guarded on the proxy like every other gateway-backed field: recording
        // a preference the gateway is not enforcing would make the portal claim
        // something untrue.
        if (proxyId) {
          const nextCors = patch.cors === undefined ? api.cors : patch.cors;
          const nextMethods =
            patch.allowed_methods === undefined ? api.allowed_methods : patch.allowed_methods;
          const proxySettings: Record<string, unknown> = {};
          // A CORS change re-derives the method list even when the provider did
          // not touch it: adding a policy has to add `OPTIONS`, and removing one
          // has to take it away again.
          if (patch.allowed_methods !== undefined || (patch.cors !== undefined && nextMethods)) {
            proxySettings.allowed_methods = proxyAllowedMethods(nextMethods, nextCors);
          }
          if (patch.timeouts !== undefined)
            Object.assign(proxySettings, timeoutFields(patch.timeouts));
          if (patch.circuit_breaker !== undefined) {
            proxySettings.circuit_breaker = patch.circuit_breaker ? DEFAULT_CIRCUIT_BREAKER : null;
          }
          if (patch.cors !== undefined) proxySettings.allowed_ws_origins = wsOriginsFor(nextCors);

          if (Object.keys(proxySettings).length > 0) {
            let written = false;
            const before = await mutateProxy(
              proxyId,
              (proxy) => {
                const record = proxy as unknown as Record<string, unknown>;
                const differs = Object.entries(proxySettings).some(
                  ([field, value]) => !isDeepStrictEqual(record[field], value),
                );
                if (!differs) return null;
                written = true;
                return { ...proxy, ...proxySettings };
              },
              actor.id,
            );
            if (written)
              undo.push(restoreProxySettings(before, Object.keys(proxySettings), actor.id));
          }

          if (patch.allowed_methods !== undefined) {
            // The row keeps the provider's list; the gateway's copy may carry an
            // extra `OPTIONS` that belongs to the CORS policy, not to this field.
            update.allowed_methods = patch.allowed_methods;
            changed.push('allowed_methods');
          }
          if (patch.timeouts !== undefined) {
            update.timeouts = patch.timeouts;
            changed.push('timeouts');
          }
          if (
            patch.circuit_breaker !== undefined &&
            patch.circuit_breaker !== api.circuit_breaker
          ) {
            update.circuit_breaker = patch.circuit_breaker;
            changed.push('circuit_breaker');
          }
        }

        // A no-op PATCH still answers with the API as the wire describes it.
        if (changed.length === 0) return presentApi(api, await settings.getGatewayPublicUrl());

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

      return presentApi(updated, await settings.getGatewayPublicUrl());
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

      // The operation table follows the document, so a `routes` API's validator
      // is regenerated here — before the revision becomes current, in the same
      // direction and for the same reason as the backend move above. A replace
      // keeps the config id, so the proxy's association list is untouched and
      // there is no window in which the plugin is missing.
      //
      // Ordered *after* the backend move so its undo runs first on the way
      // back out: the compensation below unwinds this stack in reverse and
      // then restores the backend.
      const undo: (() => Promise<void>)[] = [];
      let spec: ApiSpecRecord;
      let updated: ApiRecord;
      try {
        if (api.spec_enforcement === 'routes' && api.ferrum_proxy_id) {
          await reconcileOptionalPlugin(
            api.ferrum_proxy_id,
            findPlugin(await pluginsOf(api), OPENAPI_VALIDATOR_PLUGIN),
            OPENAPI_VALIDATOR_PLUGIN,
            openapiValidatorConfig(
              api.spec_enforcement,
              parsed.paths,
              listenPathFor(api.namespace, api.slug),
              api.cors,
            ),
            actor.id,
            undo,
          );
        }

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
        for (const step of undo.reverse()) {
          await step().catch(() => undefined);
        }
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
          spec_enforcement: api.spec_enforcement,
          backend_updated: backendUpdated,
        },
        ip,
      );

      return {
        api: presentApi(updated, await settings.getGatewayPublicUrl()),
        spec: specSummary(spec),
      };
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
      //
      //    `api_plugins` needs no gateway step of its own: every palette plugin
      //    is proxy-scoped, so deleting the proxy above already cascaded both
      //    the configs and their association rows, and the sweep that follows
      //    it covers anything a gateway left behind. Only the portal's rows are
      //    left to remove here.
      await store.transaction(async (tx) => {
        await tx.grants.deleteByApi(api.id);
        await tx.accessRequests.deleteByApi(api.id);
        await tx.apiPlugins.deleteByApi(api.id);
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
  /**
   * Undo step that puts a proxy's runtime settings back where the PATCH found
   * them.
   *
   * Only the fields that were actually written are rewound, on top of a fresh
   * read, for the same reason {@link restoreProxyBackend} is narrow: a blanket
   * restore of the captured document would also revert plugin association
   * changes made by other steps of the same PATCH, which have their own undo.
   * A field the gateway did not report falls back to its documented default —
   * a whole-resource `PUT` would otherwise drop it rather than leave it alone.
   */
  function restoreProxySettings(
    previous: EdgeProxy,
    fields: string[],
    subject: string,
  ): () => Promise<void> {
    const record = previous as unknown as Record<string, unknown>;
    const restored = Object.fromEntries(
      fields.map((field) => [field, record[field] ?? PROXY_SETTING_DEFAULTS[field] ?? null]),
    );
    return async () => {
      await mutateProxy(previous.id, (proxy) => ({ ...proxy, ...restored }), subject);
    };
  }

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
