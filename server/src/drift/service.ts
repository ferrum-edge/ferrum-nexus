import type { NexusStore } from '../db/store.js';
import type { FerrumAdminClient } from '../ferrum-admin/client.js';

export interface DriftReport {
  namespace: string;
  missingInNexus: { specId: string; title: string; version: string }[];
  drifted: { assetId: string; specId: string; localHash: string | null; remoteHash: string | null }[];
  missingInEdge: { assetId: string; specId: string }[];
}

export interface DriftService {
  detect(opts: { namespace?: string }): Promise<DriftReport>;
}

export function createDriftService(
  store: NexusStore,
  ferrum: FerrumAdminClient,
): DriftService {
  return {
    async detect({ namespace }) {
      const ns = namespace ?? 'default';
      const remote = await ferrum.listApiSpecs(ns);
      const remoteIds = new Set(remote.map((s) => s.api_spec_id));
      const remoteBySpec = new Map(remote.map((s) => [s.api_spec_id, s]));
      const { rows: assets } = await store.apiAssets.list({ limit: 10_000 });
      const localBySpec = new Map(assets.map((a) => [a.api_spec_id, a]));

      const missingInNexus = remote
        .filter((spec) => !localBySpec.has(spec.api_spec_id))
        .map((spec) => ({
          specId: spec.api_spec_id,
          title: spec.title,
          version: spec.version,
        }));

      const missingInEdge = assets
        .filter((a) => !remoteIds.has(a.api_spec_id))
        .map((a) => ({ assetId: a.id, specId: a.api_spec_id }));

      const drifted = assets
        .filter((a) => {
          const remoteSpec = remoteBySpec.get(a.api_spec_id);
          return (
            remoteSpec &&
            a.content_hash &&
            remoteSpec.content_hash &&
            remoteSpec.content_hash !== a.content_hash
          );
        })
        .map((a) => ({
          assetId: a.id,
          specId: a.api_spec_id,
          localHash: a.content_hash,
          remoteHash: remoteBySpec.get(a.api_spec_id)?.content_hash ?? null,
        }));

      return { namespace: ns, missingInNexus, missingInEdge, drifted };
    },
  };
}
