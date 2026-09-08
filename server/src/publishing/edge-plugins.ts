/**
 * The mechanics of putting a plugin on an Edge proxy — and taking it off again
 * without leaving wreckage.
 *
 * Extracted from `publishing/service.ts` so the palette service
 * (`plugins/service.ts`) drives the gateway through the *same* code rather than
 * a second, subtly different copy. Two things make that non-negotiable:
 *
 * 1. **`PUT /proxies/{id}` is a whole-resource replace with no concurrency
 *    token.** Every write therefore has to be a GET-merge-PUT serialised on the
 *    proxy id. Two implementations means two lock keys, and two lock keys means
 *    no lock at all — one of them would silently drop the other's edit to
 *    `hosts`, `upstream_id`, or the association list itself.
 * 2. **A plugin config with a matching `proxy_id` is inert until the proxy's
 *    own `plugins[]` names it** (Edge decides in `plugin_cache.rs`, see
 *    `scoped_plugin_config_applies_to_proxy`). "Created the config" and "the
 *    gateway runs it" are different claims, so every create is followed by an
 *    association write and every removal is preceded by a disassociation.
 * 3. **`PUT /plugins/config/{id}` is a whole-resource replace too**, so a body
 *    built from scratch resets every field the portal does not model —
 *    `priority_override` is the one that exists today, and any field Edge adds
 *    later behaves the same way. {@link operatorOwnedFields} carries those across and `writeBody`
 *    merges the portal's fields over them, which makes the rule structural
 *    rather than a checklist (issue #159).
 *
 * The first-class configs (`rate_limiting`, `cors`, the auth plugin, the ACL
 * gate) are still found by `proxy_id` + `plugin_name`, so an operator who
 * recreates one by hand reconciles automatically. Palette plugins are not:
 * `api_plugins.ferrum_plugin_config_id` records the config Nexus created,
 * because a proxy may legitimately carry a second config of the same name that
 * an operator made and the portal must never replace or delete (issue #153).
 *
 * @see ref-edge-admin.md §3 (proxies), §8 (plugin configs)
 */

import type { FerrumAdminClient } from '../ferrum-admin/index.js';
import type {
  EdgePluginAssociation,
  EdgePluginConfig,
  EdgePluginConfigWrite,
  EdgePluginSettings,
  EdgePluginTrigger,
  EdgeProxy,
  EdgeProxyReplace,
} from '../ferrum-admin/types.js';
import { notFound } from '../lib/errors.js';

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

/**
 * Fields of a plugin config the **portal** decides, and therefore rewrites on
 * every create and every replace.
 */
const PORTAL_OWNED_PLUGIN_FIELDS = new Set([
  'plugin_name',
  'scope',
  'proxy_id',
  'enabled',
  'config',
  'trigger',
]);

/**
 * Fields a `GET /plugins/config/{id}` returns that the **gateway** owns.
 *
 * The id travels in the URL, the namespace comes from `X-Ferrum-Namespace`, the
 * timestamps from the server, and `api_spec_id` is Edge's own claim on a config
 * its importer generated — a replace can neither claim nor disclaim it. None of
 * them belongs in a write body.
 *
 * A read-only field Edge adds to the read model later has to be listed here
 * too, or {@link operatorOwnedFields} echoes it into a body that
 * `deny_unknown_fields` refuses. That is the deliberate trade: carrying an
 * unknown field by default preserves an operator's settings, and the failure
 * mode is a loud 400 rather than a silent reset (issue #159).
 */
const SERVER_OWNED_PLUGIN_FIELDS = new Set([
  'id',
  'namespace',
  'api_spec_id',
  'created_at',
  'updated_at',
]);

/**
 * Everything on a live plugin config that is neither the portal's to set nor
 * the gateway's to own — today just `priority_override`, tomorrow whatever Edge
 * adds next.
 *
 * `PUT /plugins/config/{id}` is a whole-resource replace, so omitting a field
 * is how it is removed. Only an operator can set an execution-order override
 * (the portal exposes no control for it), and losing it changes what the
 * gateway runs and in what order — which is why it is carried rather than
 * rebuilt (issue #159).
 */
export function operatorOwnedFields(
  live: EdgePluginConfig | undefined,
): Partial<EdgePluginConfigWrite> {
  if (!live) return {};
  const carried: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(live)) {
    if (PORTAL_OWNED_PLUGIN_FIELDS.has(field) || SERVER_OWNED_PLUGIN_FIELDS.has(field)) continue;
    // `null` is how a read reports "unset"; echoing it back would be a 400
    // against a closed key set that types the field as an optional number.
    if (value === null || value === undefined) continue;
    carried[field] = value;
  }
  // The write struct names only the fields Nexus knows about, and the whole
  // point of this helper is to carry the ones it does not.
  return carried as Partial<EdgePluginConfigWrite>;
}

/**
 * The portal's settings written over the live ones, key by key.
 *
 * Only for a plugin whose portal view is a **fixed** key set — `rate_limiting`
 * and `cors`, whose bodies `publishing/service.ts` builds from the same two or
 * three fields every time. There any extra key can only have come from an
 * operator tuning the gateway directly (`allowed_headers`, `max_age`, a
 * hand-set `sync_mode` that makes a quota cluster-wide), so rebuilding the
 * object from scratch would silently discard it (issue #150).
 *
 * Deliberately **not** used for a palette plugin: those expose optional fields,
 * so a provider clearing one has to remove the key, and a merge would make that
 * impossible.
 */
export function mergeOperatorSettings(
  live: EdgePluginConfig | undefined,
  settings: EdgePluginSettings,
): EdgePluginSettings {
  const current = live?.config;
  if (!current) return settings;
  // Both sides are plain JSON objects; the union in `EdgePluginSettings` only
  // records which plugin each shape belongs to, and a merge crosses no shape.
  return { ...current, ...(settings as Record<string, unknown>) };
}

/** One entry of `Proxy.plugins`. */
function association(pluginConfigId: string): EdgePluginAssociation {
  return { plugin_config_id: pluginConfigId };
}

/** Optional properties of the plugin config resource itself, beyond `config`. */
export interface EdgePluginOptions {
  /**
   * Defaults to `true`. `false` leaves the config and its association in place
   * but stops Edge running it — the settings survive a temporary switch-off.
   */
  enabled?: boolean;
  /**
   * Per-instance execution trigger, or `null`/absent for "runs on every
   * request". Never sent as `null`: a whole-resource `PUT` removes a trigger by
   * omitting the key.
   */
  trigger?: EdgePluginTrigger | null;
}

/** Everything a caller needs to move plugin configs on and off a proxy. */
export interface EdgePluginBinder {
  /** Every plugin config scoped to a proxy, or `[]` when there is no proxy. */
  listByProxy(proxyId: string | null | undefined): Promise<EdgePluginConfig[]>;
  /** The first config for `pluginName` in a list from {@link listByProxy}. */
  find(plugins: EdgePluginConfig[], pluginName: string): EdgePluginConfig | undefined;
  /**
   * Run `fn` holding the **canonical** `proxy:<id>` lease.
   *
   * For a caller that has to compose several gateway calls into one atomic
   * rewrite — the `routes` spec revision reads the proxy, submits it back
   * inside `x-ferrum-proxy` and may have to compensate, and all three have to
   * see the same document. Everything inside must use the `…Locked` variants:
   * neither the in-process queue nor the `edge_leases` row is re-entrant, so
   * taking the same key twice deadlocks until the outer wait times out.
   */
  withProxy<T>(proxyId: string, fn: () => Promise<T>): Promise<T>;
  /** Composed operations for callers already holding this proxy's lease. */
  associateLocked: EdgePluginBinder['associate'];
  disassociateLocked: EdgePluginBinder['disassociate'];
  restorePluginsLocked: EdgePluginBinder['restorePlugins'];
  undoAttachLocked: EdgePluginBinder['undoAttach'];
  undoRemovalLocked: EdgePluginBinder['undoRemoval'];
  reconcileOptionalPluginLocked: EdgePluginBinder['reconcileOptionalPlugin'];
  /** Read one proxy, change it, write the **whole** document back. */
  mutateProxy(
    proxyId: string,
    change: (proxy: EdgeProxy) => EdgeProxyReplace | null,
    subject: string,
  ): Promise<EdgeProxy>;
  /**
   * {@link EdgePluginBinder.mutateProxy} without taking the lease.
   *
   * Only for callers already inside {@link EdgePluginBinder.withProxy} for the
   * same proxy id.
   */
  mutateProxyLocked(
    proxyId: string,
    change: (proxy: EdgeProxy) => EdgeProxyReplace | null,
    subject: string,
  ): Promise<EdgeProxy>;
  /**
   * Create a proxy-scoped plugin config. Does **not** associate it.
   *
   * `live` is the resource this create is standing in for — an undo putting a
   * deleted config back — so the fields the portal does not own survive.
   */
  attach(
    proxyId: string,
    pluginName: string,
    pluginConfig: EdgePluginSettings | null,
    subject: string,
    options?: EdgePluginOptions,
    live?: EdgePluginConfig,
  ): Promise<EdgePluginConfig>;
  /** Make the gateway actually run these configs on this proxy. Idempotent. */
  associate(proxyId: string, configIds: string[], subject: string): Promise<void>;
  /** Stop the gateway running these configs on this proxy. Idempotent. */
  disassociate(proxyId: string, configIds: string[], subject: string): Promise<void>;
  /**
   * Put a set of plugin configs back onto a proxy that was just recreated,
   * **keeping their ids**, and associate them.
   *
   * Used by the `spec_enforcement` conversion, which has to delete and recreate
   * the proxy to move it between hand-owned and spec-owned (see
   * `service.ts`). Reusing the ids is what makes that rebuild invisible to
   * everything else: the undo steps a PATCH already pushed, and any config id
   * another request read a moment ago, still address a live row. `enabled`,
   * `trigger` and `priority_override` are carried across too — a restore that
   * quietly re-enabled a switched-off plugin, dropped its trigger, or reset its
   * priority would change what the gateway runs.
   */
  restorePlugins(proxyId: string, configs: EdgePluginConfig[], subject: string): Promise<void>;
  /** Undo step for "a config was created here": detach it, then delete it. */
  undoAttach(proxyId: string, configId: string, subject: string): () => Promise<void>;
  /** Undo step for "an associated config was removed": put it back, re-associate. */
  undoRemoval(proxyId: string, config: EdgePluginConfig, subject: string): () => Promise<void>;
  /**
   * Bring one optional plugin to object settings, or remove it when `null`.
   * This sentinel is distinct from a resource's nullable `config`: restoration
   * uses attach/replace directly so an operator's null config survives.
   *
   * Returns the config as it now stands on the gateway, or `null` when it was
   * removed — the caller records the id so a later save knows which config is
   * the portal's (issue #153).
   */
  reconcileOptionalPlugin(
    proxyId: string,
    existing: EdgePluginConfig | undefined,
    pluginName: string,
    pluginSettings: EdgePluginSettings | null,
    subject: string,
    undo: (() => Promise<void>)[],
    options?: EdgePluginOptions,
  ): Promise<EdgePluginConfig | null>;
}

/** Build the plugin/proxy binder over one Ferrum Edge Admin client. */
export function createEdgePluginBinder(edge: FerrumAdminClient): EdgePluginBinder {
  /**
   * The body for a create or a replace: the portal's fields written **over**
   * whatever `live` already carries, with `trigger` omitted when absent.
   *
   * The merge is the whole point. Building the body from scratch resets every
   * field the portal does not model, because the `PUT` replaces the whole
   * resource — which is how an operator's `priority_override` used to vanish on
   * an ordinary palette save (issue #159). Passing `live` is therefore the rule
   * for every write path that has a resource in hand, not an optimisation.
   */
  function writeBody(
    proxyId: string,
    pluginName: string,
    pluginConfig: EdgePluginSettings | null,
    options: EdgePluginOptions | undefined,
    live?: EdgePluginConfig,
  ): EdgePluginConfigWrite {
    const trigger = options?.trigger ?? null;
    return {
      ...operatorOwnedFields(live),
      plugin_name: pluginName,
      scope: 'proxy',
      proxy_id: proxyId,
      enabled: options?.enabled ?? true,
      config: pluginConfig,
      // Omitted rather than `null`: Edge validates a closed key set and a
      // whole-resource `PUT` removes a trigger by not carrying one.
      ...(trigger === null ? {} : { trigger }),
    };
  }

  const binder: EdgePluginBinder = {
    async listByProxy(proxyId) {
      if (!proxyId) return [];
      return edge.pluginConfigs.listByProxy(proxyId);
    },

    find(plugins, pluginName) {
      return plugins.find((plugin) => plugin.plugin_name === pluginName);
    },

    /**
     * `PUT /proxies/{id}` is a whole-resource replace with no concurrency
     * token, so `change` receives the document the gateway just returned and
     * returns it with the handful of fields that are actually changing
     * overwritten — anything omitted from the body is reset to its serde
     * default, which is how an operator's `hosts`, timeouts, backend TLS or
     * `upstream_id` used to disappear the first time Nexus repointed a backend.
     *
     * Serialised on `proxy:<id>` for the same reason consumer writes are: two
     * concurrent GET→edit→PUT round trips would silently lose one edit — the
     * way a proxy used to end up running a rate limiter and no auth plugin. The
     * key is prefixed so it can never collide with the consumer-id keys the
     * credentials service uses, and it is the **canonical** key for a proxy:
     * every path that rewrites one goes through here, which is what lets the
     * `edge_leases` row behind it order two Nexus instances and not just two
     * calls in this process.
     *
     * `change` may return `null` to mean "already as it should be", which skips
     * the write entirely. Returns the document **as it was found**, which is
     * what an undo step needs.
     */
    async withProxy(proxyId, fn) {
      return edge.serializePerKey(`proxy:${proxyId}`, fn);
    },

    async mutateProxy(proxyId, change, subject) {
      return binder.withProxy(proxyId, () => binder.mutateProxyLocked(proxyId, change, subject));
    },

    async mutateProxyLocked(proxyId, change, subject) {
      const current = await edge.proxies.get(proxyId);
      if (!current) throw notFound('Proxy', proxyId);
      const body = change(current);
      if (body === null) return current;
      for (const field of SERVER_OWNED_PROXY_FIELDS) delete body[field];
      await edge.proxies.replace(proxyId, body, subject);
      return current;
    },

    async attach(proxyId, pluginName, pluginConfig, subject, options, live) {
      return edge.pluginConfigs.create(
        writeBody(proxyId, pluginName, pluginConfig, options, live),
        subject,
      );
    },

    /**
     * Idempotent: ids already in the list are left where they are, and a write
     * that would change nothing is skipped.
     */
    async associate(proxyId, configIds, subject) {
      return binder.withProxy(proxyId, () => binder.associateLocked(proxyId, configIds, subject));
    },

    async associateLocked(proxyId, configIds, subject) {
      await binder.mutateProxyLocked(
        proxyId,
        (proxy) => {
          const current = associatedIds(proxy);
          const additions = configIds.filter((id) => !current.includes(id));
          if (additions.length === 0) return null;
          return { ...proxy, plugins: [...current, ...additions].map(association) };
        },
        subject,
      );
    },

    /**
     * Always paired with — and ordered *before* — deleting the config. Edge's
     * `DELETE /plugins/config/{id}` clears the junction rows itself, so this is
     * not strictly required, but doing it in this order means the association
     * list never names a row that has already gone.
     */
    async disassociate(proxyId, configIds, subject) {
      return binder.withProxy(proxyId, () =>
        binder.disassociateLocked(proxyId, configIds, subject),
      );
    },

    async disassociateLocked(proxyId, configIds, subject) {
      await binder.mutateProxyLocked(
        proxyId,
        (proxy) => {
          const current = associatedIds(proxy);
          const kept = current.filter((id) => !configIds.includes(id));
          if (kept.length === current.length) return null;
          return { ...proxy, plugins: kept.map(association) };
        },
        subject,
      );
    },

    async restorePlugins(proxyId, configs, subject) {
      return binder.withProxy(proxyId, () =>
        binder.restorePluginsLocked(proxyId, configs, subject),
      );
    },

    async restorePluginsLocked(proxyId, configs, subject) {
      const ids: string[] = [];
      for (const config of configs) {
        await edge.pluginConfigs.create(
          {
            // `priority_override` and anything else Edge adds ride along here,
            // for the same reason a replace carries them: a restore that reset
            // one would change what the gateway runs.
            ...operatorOwnedFields(config),
            id: config.id,
            plugin_name: config.plugin_name,
            scope: config.scope,
            proxy_id: proxyId,
            enabled: config.enabled,
            config: config.config,
            ...(config.trigger ? { trigger: config.trigger } : {}),
          },
          subject,
        );
        ids.push(config.id);
      }
      // One association write for the whole set, for the same reason `publish`
      // makes one: until the proxy names them these configs are inert, and the
      // window in which the API is live but ungated should be one round trip
      // rather than one per plugin.
      if (ids.length > 0) await binder.associateLocked(proxyId, ids, subject);
    },

    /**
     * Registered *before* the association write, so it also cleans up a config
     * whose association never landed — detaching an id that is not in the list
     * is a no-op.
     */
    undoAttach(proxyId, configId, subject) {
      return () => binder.withProxy(proxyId, binder.undoAttachLocked(proxyId, configId, subject));
    },

    undoAttachLocked(proxyId, configId, subject) {
      return async () => {
        await binder.disassociateLocked(proxyId, [configId], subject);
        await edge.pluginConfigs.delete(configId, subject);
      };
    },

    /**
     * The original row is reused when the delete never landed, so a failure
     * between the disassociate and the delete cannot leave a second copy of the
     * same plugin behind. `enabled` and `trigger` are carried back too: a
     * restore that quietly re-enabled a switched-off plugin, or dropped its
     * trigger, would widen what the gateway runs.
     */
    undoRemoval(proxyId, config, subject) {
      return () => binder.withProxy(proxyId, binder.undoRemovalLocked(proxyId, config, subject));
    },

    undoRemovalLocked(proxyId, config, subject) {
      return async () => {
        const survivor = await edge.pluginConfigs.get(config.id);
        const id = survivor
          ? config.id
          : (
              await binder.attach(
                proxyId,
                config.plugin_name,
                config.config,
                subject,
                { enabled: config.enabled, trigger: config.trigger ?? null },
                config,
              )
            ).id;
        await binder.associateLocked(proxyId, [id], subject);
      };
    },

    /**
     * `rate_limiting`, `cors` and every palette plugin are the same problem — an
     * optional, replaceable, proxy-scoped config — so they share this. A replace
     * keeps the config id and repairs a missing association, while preserving
     * the original association state if a later step needs compensation.
     */
    async reconcileOptionalPlugin(
      proxyId,
      existing,
      pluginName,
      pluginSettings,
      subject,
      undo,
      options,
    ) {
      const lockedUndo: (() => Promise<void>)[] = [];
      try {
        return await binder.withProxy(proxyId, () =>
          binder.reconcileOptionalPluginLocked(
            proxyId,
            existing,
            pluginName,
            pluginSettings,
            subject,
            lockedUndo,
            options,
          ),
        );
      } finally {
        undo.push(...lockedUndo.map((step) => () => binder.withProxy(proxyId, step)));
      }
    },

    async reconcileOptionalPluginLocked(
      proxyId,
      existing,
      pluginName,
      pluginSettings,
      subject,
      undo,
      options,
    ) {
      if (pluginSettings === null) {
        if (!existing) return null;
        undo.push(binder.undoRemovalLocked(proxyId, existing, subject));
        await binder.disassociateLocked(proxyId, [existing.id], subject);
        await edge.pluginConfigs.delete(existing.id, subject);
        return null;
      }

      if (existing) {
        // `existing` is the live resource, so both the write and the undo carry
        // the operator's fields rather than resetting them.
        const replaced = await edge.pluginConfigs.replace(
          existing.id,
          writeBody(proxyId, pluginName, pluginSettings, options, existing),
          subject,
        );
        undo.push(async () => {
          await edge.pluginConfigs.replace(
            existing.id,
            writeBody(
              proxyId,
              pluginName,
              existing.config,
              { enabled: existing.enabled, trigger: existing.trigger ?? null },
              existing,
            ),
            subject,
          );
        });
        await binder.mutateProxyLocked(
          proxyId,
          (proxy) => {
            const current = associatedIds(proxy);
            if (current.includes(existing.id)) return null;
            // Register before PUT: a lost response can still mean it landed.
            undo.push(() => binder.disassociateLocked(proxyId, [existing.id], subject));
            return { ...proxy, plugins: [...current, existing.id].map(association) };
          },
          subject,
        );
        return replaced;
      }

      const attached = await binder.attach(proxyId, pluginName, pluginSettings, subject, options);
      undo.push(binder.undoAttachLocked(proxyId, attached.id, subject));
      await binder.associateLocked(proxyId, [attached.id], subject);
      return attached;
    },
  };

  return binder;
}

/** The proxy's association list, as plain plugin config ids. */
function associatedIds(proxy: EdgeProxy): string[] {
  return (proxy.plugins ?? []).map((entry) => entry.plugin_config_id);
}
