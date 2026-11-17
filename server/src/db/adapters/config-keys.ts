/**
 * Shared by every adapter's `ApiPluginRepo.listCarryingConfigKeys`: the SQL
 * narrowing probe, and the exact check every adapter applies to what its query
 * returns (issue #727).
 */

import type { ApiPluginRecord } from '../store.js';

/**
 * `WHERE` text and parameters for {@link ApiPluginRepo.listCarryingConfigKeys}:
 * the plugin name, and a `LIKE` on the stored JSON text for each key. `_` is a
 * `LIKE` wildcard and MySQL may compare without case, so this can only widen
 * the match; {@link carriesConfigKey} makes it exact. `null` when `keys` names
 * nothing.
 */
export function configKeyProbe(
  keys: Readonly<Record<string, readonly string[]>>,
): { sql: string; params: string[] } | null {
  const clauses: string[] = [];
  const params: string[] = [];
  for (const [pluginName, configKeys] of Object.entries(keys)) {
    if (configKeys.length === 0) continue;
    clauses.push(
      `(plugin_name = ? AND (${configKeys.map(() => 'config_json LIKE ?').join(' OR ')}))`,
    );
    params.push(pluginName, ...configKeys.map((key) => `%${JSON.stringify(key)}%`));
  }
  return clauses.length === 0 ? null : { sql: clauses.join(' OR '), params };
}

/** Whether `row`'s parsed config holds a key `keys` lists for its plugin. */
export function carriesConfigKey(
  row: Pick<ApiPluginRecord, 'plugin_name' | 'config'>,
  keys: Readonly<Record<string, readonly string[]>>,
): boolean {
  const listed = Object.hasOwn(keys, row.plugin_name) ? keys[row.plugin_name] : undefined;
  return listed?.some((key) => Object.hasOwn(row.config, key)) ?? false;
}
