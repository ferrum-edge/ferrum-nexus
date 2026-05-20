import type { NexusStore, ApiAssetRow } from '../db/store.js';
import type { ApiAsset, ApiAssetWithProvider } from '@ferrum-nexus/shared';
import { notFound } from '../lib/errors.js';

export interface CatalogService {
  list(opts: {
    limit?: number;
    offset?: number;
    search?: string;
    visibility?: 'private' | 'internal' | 'public';
    providerId?: string;
  }): Promise<{ items: ApiAssetWithProvider[]; total: number }>;
  get(id: string): Promise<ApiAssetWithProvider>;
  getBySlug(slug: string): Promise<ApiAssetWithProvider>;
}

export function createCatalogService(store: NexusStore): CatalogService {
  const toApi = (row: ApiAssetRow): ApiAsset => ({
    id: row.id,
    apiSpecId: row.api_spec_id,
    proxyId: row.proxy_id,
    namespace: row.namespace,
    providerId: row.provider_id,
    title: row.title,
    description: row.description,
    slug: row.slug,
    version: row.version,
    visibility: row.visibility,
    requestable: row.requestable === 1,
    lifecycle: row.lifecycle,
    tags: row.tags,
    contactEmail: row.contact_email,
    supportNotes: row.support_notes,
    operationCount: row.operation_count,
    contentHash: row.content_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

  const decorate = async (asset: ApiAsset): Promise<ApiAssetWithProvider> => {
    const provider = await store.users.findById(asset.providerId);
    return {
      ...asset,
      providerName: provider?.name ?? provider?.email ?? 'Unknown provider',
      providerEmail: provider?.email ?? '',
    };
  };

  return {
    async list(opts) {
      const { rows, total } = await store.apiAssets.list(opts);
      const items = await Promise.all(rows.map((row) => decorate(toApi(row))));
      return { items, total };
    },
    async get(id) {
      const row = await store.apiAssets.findById(id);
      if (!row) throw notFound('API asset not found');
      return decorate(toApi(row));
    },
    async getBySlug(slug) {
      const row = await store.apiAssets.findBySlug(slug);
      if (!row) throw notFound('API asset not found');
      return decorate(toApi(row));
    },
  };
}
