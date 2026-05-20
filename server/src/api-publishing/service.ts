import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import type { NexusStore, ApiAssetRow } from '../db/store.js';
import type { ApiAsset, ApiLifecycleStatus, ApiVisibility } from '@ferrum-nexus/shared';
import { aclGroupForApi } from '@ferrum-nexus/shared';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import type { FerrumAdminClient } from '../ferrum-admin/client.js';
import type { ResolvedConfig } from '../config/index.js';
import { extractMetadata, slugify } from './oas.js';
import type { AuditService } from '../audit/service.js';

export const PublishInput = z.object({
  rawSpec: z.string().min(1),
  visibility: z.enum(['private', 'internal', 'public']).default('private'),
  requestable: z.boolean().default(false),
  contactEmail: z.string().email().nullable().optional(),
  supportNotes: z.string().max(4000).nullable().optional(),
  lifecycle: z.enum(['draft', 'published', 'deprecated', 'retired']).default('draft'),
  namespace: z.string().optional(),
});
export type PublishInput = z.infer<typeof PublishInput>;

export const SettingsUpdate = z.object({
  visibility: z.enum(['private', 'internal', 'public']).optional(),
  requestable: z.boolean().optional(),
  contactEmail: z.string().email().nullable().optional(),
  supportNotes: z.string().max(4000).nullable().optional(),
  lifecycle: z.enum(['draft', 'published', 'deprecated', 'retired']).optional(),
  title: z.string().min(1).max(255).optional(),
  description: z.string().nullable().optional(),
});
export type SettingsUpdate = z.infer<typeof SettingsUpdate>;

export interface PublishingService {
  publish(opts: { providerId: string; input: PublishInput }): Promise<ApiAsset>;
  replaceSpec(opts: { providerId: string; assetId: string; rawSpec: string }): Promise<ApiAsset>;
  updateSettings(opts: {
    providerId: string;
    assetId: string;
    patch: SettingsUpdate;
  }): Promise<ApiAsset>;
  deleteAsset(opts: { actorId: string; assetId: string }): Promise<void>;
  ensureAccessControlPlugin(assetId: string): Promise<void>;
  importFromEdge(opts: { ownerId: string; specId: string; namespace?: string }): Promise<ApiAsset>;
  syncFromEdge(opts: { namespace?: string }): Promise<{ imported: number; updated: number; drift: number }>;
}

export function createPublishingService(
  config: ResolvedConfig,
  store: NexusStore,
  ferrum: FerrumAdminClient,
  audit: AuditService,
): PublishingService {
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

  const ensureUniqueSlug = async (base: string): Promise<string> => {
    let candidate = base;
    let n = 1;
    while (await store.apiAssets.findBySlug(candidate)) {
      n++;
      candidate = `${base}-${n}`;
    }
    return candidate;
  };

  const publish: PublishingService['publish'] = async ({ providerId, input }) => {
    const meta = extractMetadata(input.rawSpec);
    const namespace = input.namespace ?? config.ferrum.defaultNamespace;
    const created = await ferrum.createApiSpec(input.rawSpec, meta.rawContentType, namespace);
    const id = uuid();
    const slug = await ensureUniqueSlug(slugify(`${meta.title}-${meta.version}`));
    const now = new Date().toISOString();
    const row = await store.apiAssets.insert({
      id,
      api_spec_id: created.api_spec_id,
      proxy_id: created.proxy_id,
      namespace,
      provider_id: providerId,
      title: meta.title,
      description: meta.description,
      slug,
      version: meta.version,
      visibility: input.visibility,
      requestable: input.requestable ? 1 : 0,
      lifecycle: input.lifecycle,
      tags: meta.tags,
      contact_email: input.contactEmail ?? meta.contact?.email ?? null,
      support_notes: input.supportNotes ?? null,
      operation_count: meta.operationCount,
      content_hash: meta.contentHash,
      created_at: now,
      updated_at: now,
    });
    await store.apiSpecVersions.insert({
      id: uuid(),
      api_asset_id: id,
      version: meta.version,
      content_hash: meta.contentHash,
      submitted_by: providerId,
      raw_spec: input.rawSpec,
      created_at: now,
    });
    if (input.requestable) {
      await ensureAccessControlPlugin(id);
    }
    await audit.record(null, {
      action: 'api.publish',
      targetType: 'api_asset',
      targetId: id,
      after: { title: meta.title, version: meta.version, requestable: input.requestable },
    });
    return toApi(row);
  };

  const replaceSpec: PublishingService['replaceSpec'] = async ({ providerId, assetId, rawSpec }) => {
    const existing = await store.apiAssets.findById(assetId);
    if (!existing) throw notFound('API asset not found');
    if (existing.provider_id !== providerId) throw forbidden('Not the API owner');
    const meta = extractMetadata(rawSpec);
    const updatedEdge = await ferrum.replaceApiSpec(
      existing.api_spec_id,
      rawSpec,
      meta.rawContentType,
      existing.namespace,
    );
    const next = await store.apiAssets.update(assetId, {
      api_spec_id: updatedEdge.api_spec_id,
      proxy_id: updatedEdge.proxy_id,
      title: meta.title,
      description: meta.description,
      version: meta.version,
      tags: meta.tags,
      operation_count: meta.operationCount,
      content_hash: meta.contentHash,
      contact_email: existing.contact_email ?? meta.contact?.email ?? null,
    });
    await store.apiSpecVersions.insert({
      id: uuid(),
      api_asset_id: assetId,
      version: meta.version,
      content_hash: meta.contentHash,
      submitted_by: providerId,
      raw_spec: rawSpec,
      created_at: new Date().toISOString(),
    });
    if (next.requestable === 1) {
      await ensureAccessControlPlugin(assetId);
    }
    await audit.record(null, {
      action: 'api.spec_replace',
      targetType: 'api_asset',
      targetId: assetId,
      before: { version: existing.version, contentHash: existing.content_hash },
      after: { version: meta.version, contentHash: meta.contentHash },
    });
    return toApi(next);
  };

  const updateSettings: PublishingService['updateSettings'] = async ({ providerId, assetId, patch }) => {
    const existing = await store.apiAssets.findById(assetId);
    if (!existing) throw notFound('API asset not found');
    if (existing.provider_id !== providerId) throw forbidden('Not the API owner');
    const next = await store.apiAssets.update(assetId, {
      visibility: (patch.visibility ?? existing.visibility) as ApiVisibility,
      requestable:
        patch.requestable == null ? existing.requestable : patch.requestable ? 1 : 0,
      lifecycle: (patch.lifecycle ?? existing.lifecycle) as ApiLifecycleStatus,
      contact_email: patch.contactEmail === undefined ? existing.contact_email : patch.contactEmail,
      support_notes: patch.supportNotes === undefined ? existing.support_notes : patch.supportNotes,
      title: patch.title ?? existing.title,
      description: patch.description === undefined ? existing.description : patch.description,
    });
    if (next.requestable === 1) {
      await ensureAccessControlPlugin(assetId);
    }
    await audit.record(null, {
      action: 'api.settings_update',
      targetType: 'api_asset',
      targetId: assetId,
      before: existing,
      after: next,
    });
    return toApi(next);
  };

  const deleteAsset: PublishingService['deleteAsset'] = async ({ actorId, assetId }) => {
    const existing = await store.apiAssets.findById(assetId);
    if (!existing) throw notFound('API asset not found');
    try {
      await ferrum.deleteApiSpec(existing.api_spec_id, existing.namespace);
    } catch (err) {
      // If Edge already lacks the spec, continue removing the catalog row.
      // Other errors propagate.
      if (!(err instanceof Error) || !err.message.includes('404')) throw err;
    }
    await store.apiAssets.delete(assetId);
    await audit.record(null, {
      action: 'api.delete',
      targetType: 'api_asset',
      targetId: assetId,
      before: existing,
      reason: `actor=${actorId}`,
    });
  };

  const ensureAccessControlPlugin: PublishingService['ensureAccessControlPlugin'] = async (
    assetId,
  ) => {
    const asset = await store.apiAssets.findById(assetId);
    if (!asset) throw notFound('API asset not found');
    const allowed = aclGroupForApi(assetId);
    await ferrum.upsertPlugin(
      {
        name: 'access_control',
        proxy_id: asset.proxy_id,
        enabled: true,
        config: { allow: { groups: [allowed] } },
      },
      asset.namespace,
    );
  };

  const importFromEdge: PublishingService['importFromEdge'] = async ({
    ownerId,
    specId,
    namespace,
  }) => {
    const spec = await ferrum.getApiSpec(specId, namespace);
    if (!spec) throw notFound('Ferrum API spec not found');
    const raw = (await ferrum.getApiSpecRaw(specId, namespace)) ?? '';
    const meta = raw ? safeMeta(raw) : null;
    if (await store.apiAssets.findBySpecId(specId)) {
      throw conflict('already_imported', 'This API spec is already imported');
    }
    const id = uuid();
    const slug = await ensureUniqueSlug(slugify(`${spec.title}-${spec.version}`));
    const now = new Date().toISOString();
    const row = await store.apiAssets.insert({
      id,
      api_spec_id: spec.api_spec_id,
      proxy_id: spec.proxy_id,
      namespace: namespace ?? config.ferrum.defaultNamespace,
      provider_id: ownerId,
      title: spec.title,
      description: spec.description ?? null,
      slug,
      version: spec.version,
      visibility: 'private',
      requestable: 0,
      lifecycle: 'draft',
      tags: spec.tags ?? meta?.tags ?? [],
      contact_email: spec.contact?.email ?? meta?.contact?.email ?? null,
      support_notes: null,
      operation_count: spec.operation_count ?? meta?.operationCount ?? 0,
      content_hash: spec.content_hash ?? meta?.contentHash ?? null,
      created_at: now,
      updated_at: now,
    });
    await audit.record(null, {
      action: 'api.import',
      targetType: 'api_asset',
      targetId: id,
      after: { title: spec.title, specId, namespace },
    });
    return toApi(row);
  };

  const syncFromEdge: PublishingService['syncFromEdge'] = async ({ namespace }) => {
    const specs = await ferrum.listApiSpecs(namespace);
    let imported = 0;
    let updated = 0;
    let drift = 0;
    for (const spec of specs) {
      const existing = await store.apiAssets.findBySpecId(spec.api_spec_id);
      if (!existing) {
        imported++;
        continue;
      }
      if (existing.content_hash && spec.content_hash && existing.content_hash !== spec.content_hash) {
        drift++;
      }
      if (existing.title !== spec.title || existing.version !== spec.version) {
        await store.apiAssets.update(existing.id, {
          title: spec.title,
          version: spec.version,
          operation_count: spec.operation_count ?? existing.operation_count,
          content_hash: spec.content_hash ?? existing.content_hash,
        });
        updated++;
      }
    }
    return { imported, updated, drift };
  };

  return {
    publish,
    replaceSpec,
    updateSettings,
    deleteAsset,
    ensureAccessControlPlugin,
    importFromEdge,
    syncFromEdge,
  };
}

function safeMeta(raw: string): ReturnType<typeof extractMetadata> | null {
  try {
    return extractMetadata(raw);
  } catch {
    return null;
  }
}
