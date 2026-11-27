import { withoutRetiredConfigKeys, type ApiPluginTrigger } from '@ferrum-nexus/shared';

import type { EdgeRateLimitSyncConfig } from '../config/index.js';
import type {
  EdgePluginConfig,
  EdgePluginSettings,
  EdgePluginTrigger,
  EdgeProxy,
} from './types.js';

/**
 * Compression mutates request headers before deduplication fingerprints them.
 * Edge's native priorities (4050 and 3010) violate that composition rule.
 * These defaults support either attachment order, including a legacy sibling
 * still at its native priority. Live operator overrides always take precedence.
 */
export function palettePriority(pluginName: string): number | undefined {
  if (pluginName === 'compression') return 3_005;
  if (pluginName === 'request_deduplication') return 4_060;
  return undefined;
}

/** Return the sibling whose operator-owned order would make Edge reject the pair. */
export function incompatiblePaletteSibling(
  pluginName: string,
  proposed: number,
  onProxy: EdgePluginConfig[],
): string | undefined {
  const otherName = pluginName === 'compression' ? 'request_deduplication' : 'compression';
  const incompatible = onProxy.some((plugin) => {
    if (plugin.plugin_name !== otherName || !plugin.enabled) return false;
    const other = plugin.priority_override ?? (otherName === 'compression' ? 4_050 : 3_010);
    return pluginName === 'compression' ? proposed >= other : other >= proposed;
  });
  return incompatible ? otherName : undefined;
}

/**
 * The enabled `name` configs Edge merges into `proxy`, resolved the way its
 * runtime merge (and `request_deduplication::validate_composition`) resolves
 * them: the proxy's associated configs (proxy-scoped ones naming this proxy,
 * and proxy-group ones), or, when none of those is enabled, every enabled
 * global of that name. `configs` is the whole namespace (`listAll`), so an
 * operator's global or proxy-group config counts as well as a proxy's own.
 */
export function effectiveInstances(
  proxy: Pick<EdgeProxy, 'id' | 'plugins'>,
  configs: EdgePluginConfig[],
  name: string,
): EdgePluginConfig[] {
  const byId = new Map(configs.map((config) => [config.id, config]));
  const local = (proxy.plugins ?? [])
    .map((association) => byId.get(association.plugin_config_id))
    .filter(
      (config): config is EdgePluginConfig =>
        config !== undefined &&
        config.enabled &&
        config.plugin_name === name &&
        (config.scope === 'proxy' ? config.proxy_id === proxy.id : config.scope === 'proxy_group'),
    );
  if (local.length > 0) return local;
  return configs.filter(
    (config) => config.scope === 'global' && config.enabled && config.plugin_name === name,
  );
}

/**
 * An effective `request_deduplication` on the proxy, or `undefined`.
 *
 * Edge refuses `request_deduplication` beside an active `mcp_gateway` on one
 * proxy (`DYNAMIC_RESPONSE_PRESENTATION_PLUGINS`): a replay skips the MCP
 * gateway's response rewrite, which follows live upstream state. An AI-agents
 * API carries that `mcp_gateway`, so the two are refused here, both ways,
 * before any gateway write (issue #730). Any effective config counts, an
 * operator's included: Edge judges the proxy, not who wrote the config.
 */
export function activeDeduplication(
  proxy: Pick<EdgeProxy, 'id' | 'plugins'>,
  configs: EdgePluginConfig[],
): EdgePluginConfig | undefined {
  return effectiveInstances(proxy, configs, 'request_deduplication')[0];
}

/**
 * An effective `mcp_gateway` on the proxy whose hooks run, or `undefined`: its
 * own `config.enabled` is not `false`, judged after shadowing, as Edge does.
 */
export function activeMcpGateway(
  proxy: Pick<EdgeProxy, 'id' | 'plugins'>,
  configs: EdgePluginConfig[],
): EdgePluginConfig | undefined {
  return effectiveInstances(proxy, configs, 'mcp_gateway').find(
    (config) => config.config?.enabled !== false,
  );
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

/**
 * The settings one palette plugin is written to the gateway with.
 *
 * Only `request_deduplication` differs from what the provider saved: its
 * dedupe window has to be shared across replicas or two Nexus instances
 * deduplicate against two different memories, so an operator-configured Redis
 * endpoint is folded in here rather than being stored on the row. Every other
 * plugin is written as the provider configured it, less any key Edge has
 * removed: a row saved before the palette dropped one (`ip_restriction.mode`)
 * is replayed without it, so a rebuild never writes what Edge v0.9.21 refuses
 * (issue #727).
 */
export function paletteGatewaySettings(
  pluginName: string,
  saved: Record<string, unknown>,
  sync: EdgeRateLimitSyncConfig,
): EdgePluginSettings {
  const settings = withoutRetiredConfigKeys(pluginName, saved);
  if (pluginName !== 'request_deduplication') return settings;
  if (sync.syncMode !== 'redis' || sync.redisUrl === undefined) return settings;
  return {
    ...settings,
    sync_mode: 'redis',
    redis_url: sync.redisUrl,
    redis_tls: sync.redisTls,
  };
}
