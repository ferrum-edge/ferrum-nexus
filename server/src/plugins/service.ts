/**
 * The provider plugin palette — switching a curated Ferrum Edge plugin on and
 * off for one published API.
 *
 * ## Where a palette plugin lives
 *
 * Exactly where `rate_limiting` and `cors` already live: a **proxy-scoped**
 * plugin config, associated through the proxy's own `plugins[]`. There is no
 * second mechanism and no new scope.
 *
 * ```
 * apis row ─── proxy ── plugins[]  ← the association list; a config is inert
 *               ├─ plugin_config     until this names it
 *               │    …auth, access_control, rate_limiting, cors, validator
 *               └─ plugin_config     one per api_plugins row (this module)
 * ```
 *
 * The `api_plugins` row is the **portal's** record of what the provider asked
 * for; the gateway objects are the runtime truth. The Edge config id is
 * deliberately not stored — configs are looked up by `proxy_id` and
 * `plugin_name`, so an operator who recreates one by hand reconciles
 * automatically. That is the same trade `publishing/service.ts` makes, and both
 * modules drive the gateway through the one binder in `edge-plugins.ts`, which
 * matters: `PUT /proxies/{id}` is a whole-resource replace with no concurrency
 * token, so a second GET-merge-PUT implementation would mean a second lock key
 * and therefore no lock at all.
 *
 * ## Ordering, and what a failure leaves behind
 *
 * Edge has no cross-resource transaction, so `set` and `remove` build an undo
 * stack exactly as `publish` and `update` do, and the `api_plugins` row is
 * written **last, inside** that compensated block. A store failure therefore
 * cannot leave a plugin running on the gateway that the portal has no row for —
 * which for `request_termination` would mean an API stuck returning 503 with
 * nothing in the UI to turn it off.
 *
 * ## `enabled: false` is not "removed"
 *
 * The config stays on the gateway **and stays associated**; only its `enabled`
 * flag goes false, so Edge does not run it and the provider's settings survive.
 * Edge does not validate a disabled config strictly, which is deliberate on its
 * side; Nexus validates the body either way so a plugin cannot be saved in a
 * shape that will fail the moment it is switched back on.
 *
 * ## What is not here
 *
 * The auth family (`hmac_auth`, `jwks_auth`, `oauth2_introspection`,
 * `mtls_auth`) and `spec_expose` are out of scope for this service: the first
 * four change the credential model and the last needs a public spec endpoint.
 * Both are additive — an auth-family plugin would come with a credential type,
 * and `spec_expose` with a route — and neither changes the machinery below.
 */

import {
  findProviderPlugin,
  isFirstClassPlugin,
  FIRST_CLASS_PLUGIN_FIELDS,
  type ApiPlugin,
  type ApiPluginTrigger,
  type ProviderPluginDescriptor,
  type Uuid,
} from '@ferrum-nexus/shared';

import { AuditAction, type AuditService } from '../audit/service.js';
import type { NexusConfig } from '../config/index.js';
import type { ApiPluginRecord, NexusStore, UserRecord } from '../db/store.js';
import type { FerrumAdminClient } from '../ferrum-admin/index.js';
import type { EdgePluginSettings, EdgePluginTrigger } from '../ferrum-admin/types.js';
import { conflict, notFound, validationFailed } from '../lib/errors.js';
import { createEdgePluginBinder } from '../publishing/edge-plugins.js';
import type { PublishingService } from '../publishing/service.js';

/** What a `PUT /api/apis/:id/plugins/:name` asks for, already validated. */
export interface SetApiPluginInput {
  enabled: boolean;
  config: Record<string, unknown>;
  /** `null` removes an existing trigger; `undefined` never reaches here. */
  trigger: ApiPluginTrigger | null;
}

/** Palette operations. Owner-or-admin, enforced through the publishing service. */
export interface ApiPluginsService {
  /** Every palette plugin configured on an API, oldest first. */
  list(actor: UserRecord, apiId: Uuid): Promise<ApiPlugin[]>;
  /** Create or replace one palette plugin, on the gateway and in the store. */
  set(
    actor: UserRecord,
    apiId: Uuid,
    pluginName: string,
    input: SetApiPluginInput,
    ip?: string | null,
  ): Promise<ApiPlugin>;
  /** Detach and delete one palette plugin. */
  remove(actor: UserRecord, apiId: Uuid, pluginName: string, ip?: string | null): Promise<void>;
  /**
   * Resolve a plugin name to its descriptor, or raise the right error.
   *
   * `404` for a name that is not an Edge plugin Nexus knows; `400` naming the
   * responsible field for one Nexus manages elsewhere — answering `404` for
   * `key_auth` would read like the gateway does not have it.
   */
  descriptorFor(pluginName: string): ProviderPluginDescriptor;
}

/** Dependencies of {@link createApiPluginsService}. */
export interface ApiPluginsServiceDeps {
  config: NexusConfig;
  store: NexusStore;
  edge: FerrumAdminClient;
  audit: AuditService;
  /** Reused for the owner-or-admin check, so there is one definition of it. */
  publishing: PublishingService;
}

/** Strip the row's storage-only columns down to the wire shape. */
function present(row: ApiPluginRecord): ApiPlugin {
  return {
    plugin_name: row.plugin_name,
    enabled: row.enabled,
    config: row.config,
    trigger: row.trigger,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Compile the portal's trigger into the predicate tree Edge expects.
 *
 * A node sets **exactly one** of `all`/`any`/`not`/`match`, and a `match` leaf
 * sets exactly one predicate, so two conditions become an `all` of two leaves
 * and one condition stays a bare leaf — an `all` with a single child would be
 * accepted but is noise in the stored document.
 */
export function edgeTriggerFor(trigger: ApiPluginTrigger | null): EdgePluginTrigger | null {
  if (trigger === null) return null;
  const leaves: Record<string, unknown>[] = [];
  if (trigger.methods !== undefined && trigger.methods.length > 0) {
    leaves.push({ match: { method: [...trigger.methods] } });
  }
  if (trigger.path_prefix !== undefined && trigger.path_prefix !== '') {
    leaves.push({ match: { path: { prefix: [trigger.path_prefix] } } });
  }
  if (leaves.length === 0) return null;
  const first = leaves[0];
  if (leaves.length === 1 && first !== undefined) return { when: first };
  return { when: { all: leaves } };
}

/** Build the palette service. */
export function createApiPluginsService(deps: ApiPluginsServiceDeps): ApiPluginsService {
  const { config, store, edge, audit, publishing } = deps;
  const binder = createEdgePluginBinder(edge);

  function descriptorFor(pluginName: string): ProviderPluginDescriptor {
    const descriptor = findProviderPlugin(pluginName);
    if (descriptor) return descriptor;
    const field = FIRST_CLASS_PLUGIN_FIELDS[pluginName];
    if (field !== undefined && isFirstClassPlugin(pluginName)) {
      throw validationFailed(
        `Nexus manages '${pluginName}' from the API's '${field}' setting, not from the plugin ` +
          `palette; change '${field}' on the API instead`,
        { plugin_name: pluginName, field },
      );
    }
    throw notFound('Plugin', pluginName);
  }

  /**
   * The API row, checked for owner-or-admin, plus the proxy every gateway write
   * needs.
   *
   * An API with no `ferrum_proxy_id` predates its proxy or lost it; there is
   * nothing to attach a plugin to, and recording a plugin the gateway is not
   * running would make the portal claim something untrue.
   */
  async function loadTarget(
    actor: UserRecord,
    apiId: Uuid,
  ): Promise<{ apiId: Uuid; apiName: string; proxyId: string }> {
    const api = await store.apis.findById(apiId);
    if (!api) throw notFound('API', apiId);
    publishing.assertCanAdminister(actor, api);
    if (!api.ferrum_proxy_id) {
      throw conflict('This API has no gateway proxy, so no plugin can be attached to it', {
        api_id: apiId,
      });
    }
    return { apiId: api.id, apiName: api.name, proxyId: api.ferrum_proxy_id };
  }

  /**
   * The exact body sent to Edge: the descriptor's own keys, plus the shared
   * Redis settings for the one plugin that keeps cross-replica state.
   *
   * `request_deduplication` is the whole reason this is not simply `config`.
   * Its idempotency records are **per gateway process** in `local` mode, so a
   * portal in front of N data-plane replicas lets the same key execute up to N
   * times — exactly the failure `rate_limiting` has, and stamped from exactly
   * the same operator setting. `local` is Edge's own default and the Redis-only
   * keys are *rejected* outside `sync_mode: 'redis'`, so nothing is sent at all
   * in the local case.
   */
  function gatewaySettings(
    descriptor: ProviderPluginDescriptor,
    settings: Record<string, unknown>,
  ): EdgePluginSettings {
    if (descriptor.name !== 'request_deduplication') return settings;
    const sync = config.edge.rateLimit;
    if (sync.syncMode !== 'redis' || sync.redisUrl === undefined) return settings;
    return {
      ...settings,
      sync_mode: 'redis',
      redis_url: sync.redisUrl,
      redis_tls: sync.redisTls,
    };
  }

  return {
    descriptorFor,

    async list(actor, apiId) {
      const api = await store.apis.findById(apiId);
      if (!api) throw notFound('API', apiId);
      publishing.assertCanAdminister(actor, api);
      return (await store.apiPlugins.listByApi(api.id)).map(present);
    },

    async set(actor, apiId, pluginName, input, ip = null) {
      const descriptor = descriptorFor(pluginName);
      if (input.trigger !== null && !descriptor.supports_trigger) {
        // Not a portal preference: Edge refuses a trigger on a plugin that
        // publishes contextless header/trailer policy or a fixed body ceiling,
        // because a false decision could only be half-applied.
        throw validationFailed(
          `The gateway does not accept an execution trigger on '${pluginName}' — it applies to ` +
            'every request on the API or not at all',
          { plugin_name: pluginName, field: 'trigger' },
        );
      }

      const target = await loadTarget(actor, apiId);
      const trigger = edgeTriggerFor(input.trigger);
      const { saved, replaced } = await edge.serializePerKey(
        `proxy-plugin:${target.proxyId}:${pluginName}`,
        async () => {
          const matches = (await binder.listByProxy(target.proxyId)).filter(
            (plugin) => plugin.plugin_name === pluginName,
          );
          const [existing, ...duplicates] = matches;
          const undo: (() => Promise<void>)[] = [];
          try {
            await binder.reconcileOptionalPlugin(
              target.proxyId,
              existing,
              pluginName,
              gatewaySettings(descriptor, input.config),
              actor.id,
              undo,
              { enabled: input.enabled, trigger },
            );
            // Older concurrent writers may already have left duplicate configs.
            // Remove every extra while holding the same name-level lock.
            for (const duplicate of duplicates) {
              await binder.reconcileOptionalPlugin(
                target.proxyId,
                duplicate,
                pluginName,
                null,
                actor.id,
                undo,
              );
            }
            // Written last but inside the compensated block, like every other
            // gateway-then-store sequence in the portal.
            const row = await store.apiPlugins.upsert({
              api_id: target.apiId,
              plugin_name: pluginName,
              enabled: input.enabled,
              config: input.config,
              trigger: input.trigger,
            });
            return { saved: row, replaced: existing !== undefined };
          } catch (error) {
            for (const step of undo.reverse()) {
              await step().catch(() => undefined);
            }
            throw error;
          }
        },
      );

      await audit.record(
        { id: actor.id, role: actor.role },
        AuditAction.API_PLUGIN_SET,
        { type: 'api', id: target.apiId },
        {
          plugin_name: pluginName,
          enabled: input.enabled,
          // The keys, not the values: a config can carry a CSP or an IP
          // allow-list, and an audit row is not the place for either.
          config_keys: Object.keys(input.config).sort(),
          trigger: input.trigger,
          replaced,
        },
        ip,
      );

      return present(saved);
    },

    async remove(actor, apiId, pluginName, ip = null) {
      const descriptor = descriptorFor(pluginName);
      const target = await loadTarget(actor, apiId);
      const wasAttached = await edge.serializePerKey(
        `proxy-plugin:${target.proxyId}:${pluginName}`,
        async () => {
          const row = await store.apiPlugins.find(target.apiId, pluginName);
          if (!row) throw notFound('Plugin', `${apiId}/${pluginName}`);

          // Tolerant of configs an operator already removed by hand, while also
          // cleaning up every duplicate a historical concurrent save left behind.
          const matches = (await binder.listByProxy(target.proxyId)).filter(
            (plugin) => plugin.plugin_name === pluginName,
          );
          const undo: (() => Promise<void>)[] = [];
          try {
            for (const existing of matches) {
              await binder.reconcileOptionalPlugin(
                target.proxyId,
                existing,
                pluginName,
                null,
                actor.id,
                undo,
              );
            }
            await store.apiPlugins.delete(target.apiId, pluginName);
            return matches.length > 0;
          } catch (error) {
            for (const step of undo.reverse()) {
              await step().catch(() => undefined);
            }
            throw error;
          }
        },
      );

      await audit.record(
        { id: actor.id, role: actor.role },
        AuditAction.API_PLUGIN_REMOVE,
        { type: 'api', id: target.apiId },
        { plugin_name: pluginName, label: descriptor.label, was_attached: wasAttached },
        ip,
      );
    },
  };
}
