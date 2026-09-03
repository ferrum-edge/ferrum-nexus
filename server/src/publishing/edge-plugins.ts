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
 *
 * Nexus stores no Edge plugin config ids: they are looked up by `proxy_id`
 * whenever they need changing, which keeps the schema free of a lifecycle it
 * does not own and reconciles automatically if an operator recreates one.
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
  /** Read one proxy, change it, write the **whole** document back. */
  mutateProxy(
    proxyId: string,
    change: (proxy: EdgeProxy) => EdgeProxyReplace | null,
    subject: string,
  ): Promise<EdgeProxy>;
  /** Create a proxy-scoped plugin config. Does **not** associate it. */
  attach(
    proxyId: string,
    pluginName: string,
    pluginConfig: EdgePluginSettings,
    subject: string,
    options?: EdgePluginOptions,
  ): Promise<EdgePluginConfig>;
  /** Make the gateway actually run these configs on this proxy. Idempotent. */
  associate(proxyId: string, configIds: string[], subject: string): Promise<void>;
  /** Stop the gateway running these configs on this proxy. Idempotent. */
  disassociate(proxyId: string, configIds: string[], subject: string): Promise<void>;
  /** Undo step for "a config was created here": detach it, then delete it. */
  undoAttach(proxyId: string, configId: string, subject: string): () => Promise<void>;
  /** Undo step for "an associated config was removed": put it back, re-associate. */
  undoRemoval(proxyId: string, config: EdgePluginConfig, subject: string): () => Promise<void>;
  /** Bring one optional plugin to `pluginSettings`, or remove it when `null`. */
  reconcileOptionalPlugin(
    proxyId: string,
    existing: EdgePluginConfig | undefined,
    pluginName: string,
    pluginSettings: EdgePluginSettings | null,
    subject: string,
    undo: (() => Promise<void>)[],
    options?: EdgePluginOptions,
  ): Promise<void>;
}

/** Build the plugin/proxy binder over one Ferrum Edge Admin client. */
export function createEdgePluginBinder(edge: FerrumAdminClient): EdgePluginBinder {
  /** The body for a create or a replace, with `trigger` omitted when absent. */
  function writeBody(
    proxyId: string,
    pluginName: string,
    pluginConfig: EdgePluginSettings,
    options: EdgePluginOptions | undefined,
  ): EdgePluginConfigWrite {
    const trigger = options?.trigger ?? null;
    return {
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
     * Serialised on the proxy id for the same reason consumer writes are: two
     * concurrent GET→edit→PUT round trips would silently lose one edit. The key
     * is prefixed so it can never collide with the consumer-id keys the
     * credentials service uses.
     *
     * `change` may return `null` to mean "already as it should be", which skips
     * the write entirely. Returns the document **as it was found**, which is
     * what an undo step needs.
     */
    async mutateProxy(proxyId, change, subject) {
      return edge.serializePerKey(`proxy:${proxyId}`, async () => {
        const current = await edge.proxies.get(proxyId);
        if (!current) throw notFound('Proxy', proxyId);
        const body = change(current);
        if (body === null) return current;
        for (const field of SERVER_OWNED_PROXY_FIELDS) delete body[field];
        await edge.proxies.replace(proxyId, body, subject);
        return current;
      });
    },

    async attach(proxyId, pluginName, pluginConfig, subject, options) {
      return edge.pluginConfigs.create(
        writeBody(proxyId, pluginName, pluginConfig, options),
        subject,
      );
    },

    /**
     * Idempotent: ids already in the list are left where they are, and a write
     * that would change nothing is skipped.
     */
    async associate(proxyId, configIds, subject) {
      await binder.mutateProxy(
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
      await binder.mutateProxy(
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

    /**
     * Registered *before* the association write, so it also cleans up a config
     * whose association never landed — detaching an id that is not in the list
     * is a no-op.
     */
    undoAttach(proxyId, configId, subject) {
      return async () => {
        await binder.disassociate(proxyId, [configId], subject);
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
      return async () => {
        const survivor = await edge.pluginConfigs.get(config.id);
        const id = survivor
          ? config.id
          : (
              await binder.attach(proxyId, config.plugin_name, config.config, subject, {
                enabled: config.enabled,
                trigger: config.trigger ?? null,
              })
            ).id;
        await binder.associate(proxyId, [id], subject);
      };
    },

    /**
     * `rate_limiting`, `cors` and every palette plugin are the same problem — an
     * optional, replaceable, proxy-scoped config — so they share this. Note the
     * asymmetry: a replace keeps the config id, so only the create and the
     * delete touch the proxy's association list.
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
      if (pluginSettings === null) {
        if (!existing) return;
        undo.push(binder.undoRemoval(proxyId, existing, subject));
        await binder.disassociate(proxyId, [existing.id], subject);
        await edge.pluginConfigs.delete(existing.id, subject);
        return;
      }

      if (existing) {
        await edge.pluginConfigs.replace(
          existing.id,
          writeBody(proxyId, pluginName, pluginSettings, options),
          subject,
        );
        undo.push(async () => {
          await edge.pluginConfigs.replace(
            existing.id,
            writeBody(proxyId, pluginName, existing.config, {
              enabled: existing.enabled,
              trigger: existing.trigger ?? null,
            }),
            subject,
          );
        });
        return;
      }

      const attached = await binder.attach(proxyId, pluginName, pluginSettings, subject, options);
      undo.push(binder.undoAttach(proxyId, attached.id, subject));
      await binder.associate(proxyId, [attached.id], subject);
    },
  };

  return binder;
}

/** The proxy's association list, as plain plugin config ids. */
function associatedIds(proxy: EdgeProxy): string[] {
  return (proxy.plugins ?? []).map((entry) => entry.plugin_config_id);
}
