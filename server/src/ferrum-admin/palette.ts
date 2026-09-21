import type { ApiPluginTrigger } from '@ferrum-nexus/shared';

import type { EdgeRateLimitSyncConfig } from '../config/index.js';
import type { EdgePluginConfig, EdgePluginSettings, EdgePluginTrigger } from './types.js';

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
 * plugin is written exactly as the provider configured it.
 */
export function paletteGatewaySettings(
  pluginName: string,
  settings: Record<string, unknown>,
  sync: EdgeRateLimitSyncConfig,
): EdgePluginSettings {
  if (pluginName !== 'request_deduplication') return settings;
  if (sync.syncMode !== 'redis' || sync.redisUrl === undefined) return settings;
  return {
    ...settings,
    sync_mode: 'redis',
    redis_url: sync.redisUrl,
    redis_tls: sync.redisTls,
  };
}
