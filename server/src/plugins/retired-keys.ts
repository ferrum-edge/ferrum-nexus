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
 * {@link ApiPluginsService.stripRetiredConfigKeys}. Every rewrite is
 * idempotent, and a start that finds nothing to rewrite only reads the store,
 * so the pass simply runs again each time: nothing it misses (a row whose
 * rewrite failed, or one a concurrent change made it give up on) is ever
 * excused by an earlier run.
 *
 * The first run that finishes for a namespace with nothing failed records an
 * `api.plugin_keys_stripped` audit row targeting that namespace, which is what
 * an operator checks before upgrading Edge.
 *
 * API rows are read in offset pages, and an API deleted mid-run shifts the
 * rows behind it, so the pass reads them again from the start until a whole
 * read meets no API it has not already handled.
 */

import { MAX_PAGE_SIZE, RETIRED_PLUGIN_CONFIG_KEYS, type Uuid } from '@ferrum-nexus/shared';

import { AuditAction, SYSTEM_ACTOR, type AuditService } from '../audit/service.js';
import type { ApiRecord, NexusStore } from '../db/store.js';
import type { KeyedSerializer } from '../lib/keyed-serializer.js';
import type { ApiPluginsService } from './service.js';

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
  /** Rows whose rewrite failed; the namespace is recorded only when this is `0`. */
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
  /** Logs a row whose rewrite failed; only identifiers, never config values. */
  log?: (obj: Record<string, unknown>, message: string) => void;
  /** APIs read per page; defaults to `MAX_PAGE_SIZE`. */
  pageSize?: number;
}

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

/**
 * Every API in `namespace` that existed for the whole read, each once.
 *
 * A pass over offset pages, repeated until a pass yields nothing new: an API
 * deleted behind the cursor makes the next page skip one, and the repeat
 * finds it. Rows created during the run are clean already, because no save
 * accepts a removed key.
 */
async function* everyApi(
  store: NexusStore,
  namespace: string,
  pageSize: number,
): AsyncGenerator<ApiRecord> {
  const seen = new Set<Uuid>();
  for (;;) {
    let fresh = false;
    let offset = 0;
    for (;;) {
      const page = await store.apis.list({ namespace }, { limit: pageSize, offset });
      for (const api of page.items) {
        if (seen.has(api.id)) continue;
        seen.add(api.id);
        fresh = true;
        yield api;
      }
      offset += page.items.length;
      if (page.items.length === 0 || offset >= page.total) break;
    }
    if (!fresh) return;
  }
}

/** Rewrite every palette config in `namespace` that carries a key Edge removed. */
export async function stripRetiredPaletteKeys(deps: RetiredKeysDeps): Promise<RetiredKeysResult> {
  const { store, audit, apiPlugins, locks, namespace } = deps;
  const pageSize = deps.pageSize ?? MAX_PAGE_SIZE;
  return locks(retiredKeysLockKey(namespace), async () => {
    const result: RetiredKeysResult = {
      alreadyRecorded: await namespaceRecorded(store, namespace),
      rewritten: 0,
      failed: 0,
    };
    for await (const api of everyApi(store, namespace, pageSize)) {
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
    if (result.failed > 0 || result.alreadyRecorded) return result;
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
