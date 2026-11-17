/**
 * The one-off rewrite of palette configs that still carry a key Edge removed
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
 * So at startup, while the gateway is still on v0.9.20, every palette row in
 * this namespace that carries one is rewritten without it, on the gateway
 * (only the config the row owns) and in the store, through
 * {@link ApiPluginsService.stripRetiredConfigKeys}. The run is recorded once,
 * with an `api.plugin_keys_stripped` audit row, only when every
 * candidate was rewritten; a run that met a failure (the gateway unreachable,
 * say) records nothing and the next start tries again. Every rewrite is
 * idempotent, so a repeat only finishes what is left.
 */

import { MAX_PAGE_SIZE, RETIRED_PLUGIN_CONFIG_KEYS } from '@ferrum-nexus/shared';

import { AuditAction, SYSTEM_ACTOR, type AuditService } from '../audit/service.js';
import type { NexusStore } from '../db/store.js';
import type { KeyedSerializer } from '../lib/keyed-serializer.js';
import type { ApiPluginsService } from './service.js';

/** Lease key every instance's run holds. */
export const RETIRED_KEYS_LOCK_KEY = 'palette:retired-config-keys:v1';

/** What {@link stripRetiredPaletteKeys} did. */
export interface RetiredKeysResult {
  /** `true` when an earlier start already recorded the run; nothing was read. */
  alreadyRecorded: boolean;
  /** Palette rows rewritten without a removed key. */
  rewritten: number;
  /** Rows whose rewrite failed; the run is recorded only when this is `0`. */
  failed: number;
}

/** Dependencies of {@link stripRetiredPaletteKeys}. */
export interface RetiredKeysDeps {
  store: NexusStore;
  audit: AuditService;
  apiPlugins: ApiPluginsService;
  /** The store-level serializer; the run holds {@link RETIRED_KEYS_LOCK_KEY}. */
  locks: KeyedSerializer;
  /** The Edge namespace whose APIs are rewritten. */
  namespace: string;
  /** Logs a row whose rewrite failed; only identifiers, never config values. */
  log?: (obj: Record<string, unknown>, message: string) => void;
  /** APIs read per page; defaults to `MAX_PAGE_SIZE`. */
  pageSize?: number;
}

async function runRecorded(store: Pick<NexusStore, 'auditLogs'>): Promise<boolean> {
  const recorded = await store.auditLogs.list(
    { action: AuditAction.API_PLUGIN_KEYS_STRIPPED },
    { limit: 1 },
  );
  return recorded.items.length > 0;
}

/** Rewrite every palette config that carries a key Edge removed, once per database. */
export async function stripRetiredPaletteKeys(deps: RetiredKeysDeps): Promise<RetiredKeysResult> {
  const { store, audit, apiPlugins, locks, namespace } = deps;
  const pageSize = deps.pageSize ?? MAX_PAGE_SIZE;
  return locks(RETIRED_KEYS_LOCK_KEY, async () => {
    if (await runRecorded(store)) return { alreadyRecorded: true, rewritten: 0, failed: 0 };
    const result: RetiredKeysResult = { alreadyRecorded: false, rewritten: 0, failed: 0 };
    // Offset pages over the API rows, which this run never changes.
    let offset = 0;
    for (;;) {
      const page = await store.apis.list({ namespace }, { limit: pageSize, offset });
      for (const api of page.items) {
        for (const row of await store.apiPlugins.listByApi(api.id)) {
          const retired = RETIRED_PLUGIN_CONFIG_KEYS[row.plugin_name];
          if (!retired?.some((key) => Object.hasOwn(row.config, key))) continue;
          try {
            const removed = await apiPlugins.stripRetiredConfigKeys(api.id, row.plugin_name);
            if (removed.length > 0) result.rewritten += 1;
          } catch (error) {
            result.failed += 1;
            deps.log?.(
              {
                api_id: api.id,
                plugin_name: row.plugin_name,
                error: error instanceof Error ? error.message : String(error),
              },
              'Could not strip removed keys from a palette plugin; the next start tries again',
            );
          }
        }
      }
      offset += page.items.length;
      if (page.items.length === 0 || offset >= page.total) break;
    }
    if (result.failed > 0) return result;
    // Recorded last, under the lease and fenced by it, so a run that stopped
    // part-way is simply run again by the next start.
    return store.transaction(async (tx) => {
      if (await runRecorded(tx)) return { ...result, alreadyRecorded: true };
      await audit
        .forStore(tx)
        .record(
          SYSTEM_ACTOR,
          AuditAction.API_PLUGIN_KEYS_STRIPPED,
          { type: 'api_plugins', id: null },
          { rewritten: result.rewritten },
        );
      return result;
    });
  });
}
