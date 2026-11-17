/**
 * The rewrite of palette configs that still carry a key Edge removed
 * (issue #727).
 *
 * Until this release the palette wrote `ip_restriction.mode` on every save (the
 * form seeded it with its default), and the retired `response_caching` could
 * carry `cache_key_include_query`. Edge v0.9.20 accepts both but they decide
 * nothing; the next Edge release refuses them as unknown keys. `ip_restriction`
 * is fail-closed, so one such enabled config stops a database-mode gateway
 * from starting after that upgrade, and these rows are Nexus's to rewrite, not
 * the operator's.
 *
 * So at every start, while the gateway is still on v0.9.20, every palette row
 * in this namespace that carries one is rewritten without it, on the gateway
 * (only the config the row owns) and in the store, through
 * {@link ApiPluginsService.stripRetiredConfigKeys}. The rows are found with one
 * store query over the affected plugins' rows
 * (`apiPlugins.listCarryingConfigKeys`), so a store with nothing left costs one
 * query, and a row a run misses (a failed rewrite, an API whose conversion or
 * restore had not finished) is found again by the next start. No earlier run
 * excuses one.
 *
 * The first run that finishes for a namespace with nothing failed or deferred
 * records an `api.plugin_keys_stripped` audit row targeting that namespace,
 * which is what an operator checks before upgrading Edge.
 */

import { RETIRED_PLUGIN_CONFIG_KEYS } from '@ferrum-nexus/shared';

import { AuditAction, SYSTEM_ACTOR, type AuditService } from '../audit/service.js';
import type { ApiPluginRecord, ApiRecord, NexusStore } from '../db/store.js';
import type { KeyedSerializer } from '../lib/keyed-serializer.js';
import type { ApiPluginsService } from './service.js';

const DEFERRED_MESSAGE =
  'Left removed palette keys for an unfinished conversion or restore; a later start strips them';
const FAILED_MESSAGE =
  'Could not strip removed keys from a palette plugin; the next start tries again';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Lease key a namespace's run holds, on every instance. */
export function retiredKeysLockKey(namespace: string): string {
  return `palette:retired-config-keys:v1:${namespace}`;
}

/** What {@link stripRetiredPaletteKeys} did. */
export interface RetiredKeysResult {
  /** `true` when an earlier run had already recorded this namespace as clean. */
  alreadyRecorded: boolean;
  /** Palette rows rewritten without a removed key. */
  rewritten: number;
  /** Rows left for an unfinished conversion or restore to settle first. */
  deferred: number;
  /** Rows whose rewrite failed. */
  failed: number;
}

/** Dependencies of {@link stripRetiredPaletteKeys}. */
export interface RetiredKeysDeps {
  store: NexusStore;
  audit: AuditService;
  apiPlugins: Pick<ApiPluginsService, 'stripRetiredConfigKeys'>;
  /** The store-level serializer; the run holds {@link retiredKeysLockKey}. */
  locks: KeyedSerializer;
  /** The Edge namespace whose APIs are rewritten. */
  namespace: string;
  /** Logs a row left for later; only identifiers, never config values. */
  log?: (obj: Record<string, unknown>, message: string) => void;
  /** API ids read per `findManyByIds` call; defaults to {@link API_BATCH}. */
  batchSize?: number;
}

/**
 * API ids per parent lookup. SQLite caps bound parameters per statement
 * (32,766 in the bundled build) and `findManyByIds` binds one per id, so an
 * upgrade with more legacy rows than that must not look them up in one call.
 */
export const API_BATCH = 500;

async function namespaceRecorded(
  store: Pick<NexusStore, 'auditLogs'>,
  namespace: string,
): Promise<boolean> {
  const recorded = await store.auditLogs.list(
    {
      action: AuditAction.API_PLUGIN_KEYS_STRIPPED,
      target_type: 'namespace',
      target_id: namespace,
    },
    { limit: 1 },
  );
  return recorded.items.length > 0;
}

/** Rewrite every palette config in `namespace` that carries a key Edge removed. */
export async function stripRetiredPaletteKeys(deps: RetiredKeysDeps): Promise<RetiredKeysResult> {
  const { store, audit, apiPlugins, locks, namespace } = deps;
  return locks(retiredKeysLockKey(namespace), async () => {
    const result: RetiredKeysResult = {
      alreadyRecorded: await namespaceRecorded(store, namespace),
      rewritten: 0,
      deferred: 0,
      failed: 0,
    };
    const rows = await store.apiPlugins.listCarryingConfigKeys(RETIRED_PLUGIN_CONFIG_KEYS);
    // Only this namespace's: another namespace's pass rewrites its own.
    const ids = [...new Set(rows.map((row) => row.api_id))];
    const batch = deps.batchSize ?? API_BATCH;
    const apis = new Map<string, ApiRecord>();
    for (let start = 0; start < ids.length; start += batch) {
      for (const api of await store.apis.findManyByIds(ids.slice(start, start + batch))) {
        apis.set(api.id, api);
      }
    }
    const report = (row: ApiPluginRecord, message: string, error?: unknown): void => {
      deps.log?.(
        {
          api_id: row.api_id,
          plugin_name: row.plugin_name,
          ...(error === undefined ? {} : { error: errorMessage(error) }),
        },
        message,
      );
    };
    for (const row of rows) {
      if (apis.get(row.api_id)?.namespace !== namespace) continue;
      try {
        const outcome = await apiPlugins.stripRetiredConfigKeys(row.api_id, row.plugin_name);
        if (outcome === 'rewritten') result.rewritten += 1;
        if (outcome === 'deferred') {
          result.deferred += 1;
          report(row, DEFERRED_MESSAGE);
        }
      } catch (error) {
        result.failed += 1;
        report(row, FAILED_MESSAGE, error);
      }
    }
    if (result.failed > 0 || result.deferred > 0 || result.alreadyRecorded) return result;
    // Recorded last, under the lease and fenced by it, once per namespace.
    return store.transaction(async (tx) => {
      if (await namespaceRecorded(tx, namespace)) return { ...result, alreadyRecorded: true };
      await audit
        .forStore(tx)
        .record(
          SYSTEM_ACTOR,
          AuditAction.API_PLUGIN_KEYS_STRIPPED,
          { type: 'namespace', id: namespace },
          { namespace, rewritten: result.rewritten },
        );
      return result;
    });
  });
}
