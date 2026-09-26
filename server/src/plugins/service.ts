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
 * for; the gateway objects are the runtime truth. Both modules drive the
 * gateway through the one binder in `edge-plugins.ts`, which matters:
 * `PUT /proxies/{id}` is a whole-resource replace with no concurrency token, so
 * a second GET-merge-PUT implementation would mean a second lock key and
 * therefore no lock at all.
 *
 * ## Ownership is a config id, not a plugin name
 *
 * The row records the Edge config id this service created
 * (`ferrum_plugin_config_id`), and `set`/`remove` act on **that config alone**.
 * Edge genuinely supports several configs of one plugin name on a proxy —
 * distinct triggers, distinct `priority_override`s — so a name is not an
 * identity, and an operator's hand-made per-path gate is not the portal's to
 * replace or delete. Resolving by name did exactly that: an unchanged palette
 * save deleted it, silently (issue #153).
 *
 * A row without a recorded config id owns no gateway config. Saving it creates
 * a new config and records that id; removal leaves unowned configs alone.
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
  MAX_PAGE_SIZE,
  type ApiPlugin,
  type ApiPluginTrigger,
  type ProviderPluginDescriptor,
  type Uuid,
} from '@ferrum-nexus/shared';

import { AuditAction, type AuditService } from '../audit/service.js';
import type { NexusConfig } from '../config/index.js';
import type { ApiPluginRecord, NexusStore, UserRecord } from '../db/store.js';
import {
  edgeTriggerFor,
  incompatiblePaletteSibling,
  paletteGatewaySettings,
  palettePriority,
} from '../ferrum-admin/palette.js';
import type { FerrumAdminClient } from '../ferrum-admin/index.js';
import type {
  EdgePluginConfig,
  EdgePluginSettings,
  EdgePluginTrigger,
} from '../ferrum-admin/types.js';
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
  /**
   * Structured logger, at `error`, for a compensation step that could not undo
   * what it was undoing.
   *
   * The same obligation `publishing/service.ts` documents: a swallowed undo
   * failure is a divergence between the portal and the gateway that no response
   * describes and no later request revisits, so it has to leave a trace
   * somewhere. Only the error message is logged — a plugin config can carry a
   * Content-Security-Policy or a partner IP allow-list, and neither belongs in
   * a log line any more than in an audit row.
   */
  log?: (obj: Record<string, unknown>, message: string) => void;
}

/** A thrown value as a string, for a log line. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

  /**
   * The gateway config this API's palette row owns, or `undefined` when there
   * is none to reuse and a fresh one has to be created.
   *
   * Ownership requires a recorded id. A missing id never authorizes adopting
   * or deleting an operator's config with the same plugin name.
   *
   * A recorded id that is no longer on the proxy means an operator deleted the
   * config by hand. That is not an error and not a licence to adopt whatever
   * else carries the name: the caller creates a new config and records its id.
   */
  function ownedConfig(
    row: ApiPluginRecord | null,
    onProxy: EdgePluginConfig[],
    pluginName: string,
  ): EdgePluginConfig | undefined {
    if (!row?.ferrum_plugin_config_id) return undefined;
    const named = onProxy.filter((plugin) => plugin.plugin_name === pluginName);
    return named.find((plugin) => plugin.id === row.ferrum_plugin_config_id);
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
      if (pluginName === 'response_caching' && input.enabled) {
        throw validationFailed(
          'Response caching is no longer offered: authenticated responses require explicit ' +
            'backend Cache-Control shared-cache opt-in; consumer key settings cannot enable it',
          { plugin_name: pluginName },
        );
      }
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
      // Serialize palette composition decisions across names. Binder operations
      // nest the distinct canonical proxy lock in this same order.
      const saved = await edge.serializePerKey(`proxy-palette:${target.proxyId}`, async () => {
        const row = await store.apiPlugins.find(target.apiId, pluginName);
        if (pluginName === 'response_caching' && !row) {
          throw validationFailed('Response caching is retired and cannot be added to an API');
        }
        // Only the config this row owns. Every other config of the same name
        // on the proxy belongs to an operator and is neither replaced nor
        // deleted here — the purge that used to follow this line removed
        // hand-made deny gates that Nexus had never created (issue #153).
        const onProxy = await binder.listByProxy(target.proxyId);
        const existing = ownedConfig(row, onProxy, pluginName);
        const priorityOverride = palettePriority(pluginName);
        if (input.enabled && priorityOverride !== undefined) {
          const otherName = incompatiblePaletteSibling(
            pluginName,
            existing?.priority_override ?? priorityOverride,
            onProxy,
          );
          if (otherName) {
            throw validationFailed(
              'compression must run before request_deduplication; ask the gateway operator ' +
                'to lower compression priority_override or raise request_deduplication priority_override',
              { plugin_name: pluginName, conflicting_plugin: otherName },
            );
          }
        }
        const undo: (() => Promise<void>)[] = [];
        try {
          const written = await binder.reconcileOptionalPlugin(
            target.proxyId,
            existing,
            pluginName,
            paletteGatewaySettings(descriptor.name, input.config, config.edge.rateLimit),
            actor.id,
            undo,
            { enabled: input.enabled, trigger, priorityOverride },
          );
          // Written last but inside the compensated block, like every other
          // gateway-then-store sequence in the portal — and with its audit
          // row, so a failed insert rolls the row back and the catch below
          // puts the gateway back too, rather than leaving the plugin
          // applied and unaudited behind a `500`.
          const configId = written?.id ?? null;
          const replaced = existing !== undefined;
          return await store.transaction(async (tx) => {
            const upserted = await tx.apiPlugins.upsert({
              api_id: target.apiId,
              plugin_name: pluginName,
              enabled: input.enabled,
              config: input.config,
              trigger: input.trigger,
              ferrum_plugin_config_id: configId,
            });
            await audit.forStore(tx).record(
              { id: actor.id, role: actor.role },
              AuditAction.API_PLUGIN_SET,
              { type: 'api', id: target.apiId },
              {
                plugin_name: pluginName,
                enabled: input.enabled,
                // The keys, not the values: a config can carry a CSP or an
                // IP allow-list, and an audit row is not the place for
                // either.
                config_keys: Object.keys(input.config).sort(),
                trigger: input.trigger,
                replaced,
                // Which config was written, so the log says what was touched
                // rather than only that something of this name was.
                plugin_config_id: configId,
              },
              ip,
            );
            return upserted;
          });
        } catch (error) {
          // Best-effort by contract: the request is already failing and an
          // undo step must not replace the failure the caller needs to see
          // with its own. Every step here replays a plugin write or an
          // association, so the gateway stays describable whichever way one
          // goes — but a swallowed failure is a divergence between the
          // `api_plugins` row and the proxy that nothing else will revisit,
          // so it is logged.
          for (const step of undo.reverse()) {
            await step().catch((undoError: unknown) => {
              deps.log?.(
                {
                  api_id: target.apiId,
                  proxy_id: target.proxyId,
                  plugin_name: pluginName,
                  error: errorMessage(undoError),
                },
                'a palette plugin compensation step failed; the gateway may not match the portal',
              );
            });
          }
          throw error;
        }
      });

      return present(saved);
    },

    async remove(actor, apiId, pluginName, ip = null) {
      const descriptor = descriptorFor(pluginName);
      const target = await loadTarget(actor, apiId);
      // Same key, same nesting contract as `set` above.
      await edge.serializePerKey(`proxy-palette:${target.proxyId}`, async () => {
        const row = await store.apiPlugins.find(target.apiId, pluginName);
        if (!row) throw notFound('Plugin', `${apiId}/${pluginName}`);

        // Exactly one config is deleted: the one this row owns. Tolerant of a
        // config an operator already removed by hand (`undefined`), and of a
        // second config of the same name that was never the portal's to
        // delete in the first place (issue #153).
        const existing = ownedConfig(row, await binder.listByProxy(target.proxyId), pluginName);
        const removedConfigId = existing?.id ?? null;

        // The attempt is recorded before the gateway is touched, as a
        // deletion's is: the config delete below is not something a failed
        // record can take back, so a failure to record the removal that
        // follows still leaves a row naming who started it — and a failure to
        // record *this* stops the removal before anything has changed.
        const startedId = await store.transaction(async (tx) => {
          const started = await audit.forStore(tx).record(
            { id: actor.id, role: actor.role },
            AuditAction.API_PLUGIN_REMOVE_START,
            { type: 'api', id: target.apiId },
            {
              plugin_name: pluginName,
              label: descriptor.label,
              plugin_config_id: removedConfigId,
            },
            ip,
          );
          return started.id;
        });

        if (existing) {
          const undo: (() => Promise<void>)[] = [];
          try {
            await binder.reconcileOptionalPlugin(
              target.proxyId,
              existing,
              pluginName,
              null,
              actor.id,
              undo,
            );
          } catch (error) {
            // The same best-effort contract as `set` above, swallowed for the
            // same reason and logged for the same one.
            for (const step of undo.reverse()) {
              await step().catch((undoError: unknown) => {
                deps.log?.(
                  {
                    api_id: target.apiId,
                    proxy_id: target.proxyId,
                    plugin_name: pluginName,
                    error: errorMessage(undoError),
                  },
                  'a palette plugin compensation step failed; the gateway may not match the portal',
                );
              });
            }
            throw error;
          }
        }

        // The row and its audit record commit together. Written after the
        // commit, a failed insert left the plugin gone and unaudited behind a
        // `500`. Now the row survives for the removal to be repeated — not
        // undone: a config put back would carry a new id the row does not
        // record, and so would no longer be the portal's to remove. The repeat
        // finds the config already gone and recognises its own earlier
        // attempt by the start row naming the config this row owned.
        await store.transaction(async (tx) => {
          let removed: Record<string, unknown> = {
            was_attached: removedConfigId !== null,
            plugin_config_id: removedConfigId,
          };
          if (removedConfigId === null && row.ferrum_plugin_config_id !== null) {
            const attempts = await tx.auditLogs.list(
              {
                action: AuditAction.API_PLUGIN_REMOVE_START,
                target_type: 'api',
                target_id: target.apiId,
              },
              { limit: MAX_PAGE_SIZE },
            );
            const earlier = attempts.items.some(
              (entry) =>
                entry.id !== startedId &&
                entry.details.plugin_name === pluginName &&
                entry.details.plugin_config_id === row.ferrum_plugin_config_id,
            );
            if (earlier) {
              removed = {
                was_attached: true,
                plugin_config_id: row.ferrum_plugin_config_id,
                resumed: true,
              };
            }
          }
          await tx.apiPlugins.delete(target.apiId, pluginName);
          await audit.forStore(tx).record(
            { id: actor.id, role: actor.role },
            AuditAction.API_PLUGIN_REMOVE,
            { type: 'api', id: target.apiId },
            { plugin_name: pluginName, label: descriptor.label, ...removed },
            ip,
          );
        });
      });
    },
  };
}
