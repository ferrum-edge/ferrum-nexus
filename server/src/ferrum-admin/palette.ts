import type { EdgePluginConfig } from './types.js';

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
