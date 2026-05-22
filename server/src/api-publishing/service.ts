import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import type { NexusStore, ApiAssetRow, PolicyExceptionRequestRow } from '../db/store.js';
import type { ApiAsset, ApiLifecycleStatus, ApiVisibility } from '@ferrum-nexus/shared';
import { aclGroupForApi } from '@ferrum-nexus/shared';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import type { FerrumAdminClient } from '../ferrum-admin/client.js';
import type { ResolvedConfig } from '../config/index.js';
import { extractMetadata, normalizeAndExtractMetadata, slugify, type OasMetadata } from './oas.js';
import type { AuditActor, AuditService } from '../audit/service.js';
import type { PolicyService } from '../governance/policy-service.js';

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
  publish(opts: {
    providerId: string;
    input: PublishInput;
    actor?: AuditActor | null;
  }): Promise<ApiAsset>;
  replaceSpec(opts: {
    providerId: string;
    assetId: string;
    rawSpec: string;
    actor?: AuditActor | null;
  }): Promise<ApiAsset>;
  updateSettings(opts: {
    providerId: string;
    assetId: string;
    patch: SettingsUpdate;
    actor?: AuditActor | null;
  }): Promise<ApiAsset>;
  deleteAsset(opts: { actorId: string; assetId: string; actor?: AuditActor | null }): Promise<void>;
  ensureAccessControlPlugin(assetId: string): Promise<void>;
  importFromEdge(opts: {
    ownerId: string;
    specId: string;
    namespace?: string;
    actor?: AuditActor | null;
  }): Promise<ApiAsset>;
  syncFromEdge(opts: { namespace?: string }): Promise<{ imported: number; updated: number; drift: number }>;
  publishStaged(opts: {
    pendingPublishId: string;
    exception: PolicyExceptionRequestRow;
    actor?: AuditActor | null;
  }): Promise<ApiAsset>;
}

export function createPublishingService(
  config: ResolvedConfig,
  store: NexusStore,
  ferrum: FerrumAdminClient,
  audit: AuditService,
  policy?: PolicyService,
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
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    contactUrl: row.contact_url,
    supportNotes: row.support_notes,
    operationCount: row.operation_count,
    contentHash: row.content_hash,
    proxyHosts: row.proxy_hosts,
    proxyPaths: row.proxy_paths,
    proxyUpstreamUrl: row.proxy_upstream_url,
    timeoutConnectMs: row.timeout_connect_ms,
    timeoutReadMs: row.timeout_read_ms,
    timeoutWriteMs: row.timeout_write_ms,
    bodySizeLimitBytes: row.body_size_limit_bytes,
    rateLimitPerMinute: row.rate_limit_per_minute,
    operationPaths: row.operation_paths,
    operationSummaries: row.operation_summaries,
    sourceFormat: row.source_format,
    policyExceptionId: row.policy_exception_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

  const factColumns = (meta: OasMetadata): Pick<
    ApiAssetRow,
    | 'proxy_hosts'
    | 'proxy_paths'
    | 'proxy_upstream_url'
    | 'timeout_connect_ms'
    | 'timeout_read_ms'
    | 'timeout_write_ms'
    | 'body_size_limit_bytes'
    | 'rate_limit_per_minute'
    | 'operation_paths'
    | 'operation_summaries'
    | 'source_format'
    | 'policy_exception_id'
  > => ({
    proxy_hosts: meta.keyFacts.proxyHosts,
    proxy_paths: meta.keyFacts.proxyPaths,
    proxy_upstream_url: meta.keyFacts.upstreamUrl,
    timeout_connect_ms: meta.keyFacts.timeoutConnectMs,
    timeout_read_ms: meta.keyFacts.timeoutReadMs,
    timeout_write_ms: meta.keyFacts.timeoutWriteMs,
    body_size_limit_bytes: meta.keyFacts.bodySizeLimitBytes,
    rate_limit_per_minute: meta.keyFacts.rateLimitPerMinute,
    operation_paths: meta.keyFacts.operationPaths,
    operation_summaries: meta.keyFacts.operationSummaries,
    source_format: meta.sourceFormat,
    policy_exception_id: null,
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

  const enforcePolicyOrStage = async (opts: {
    providerId: string;
    rawSpec: string;
    publishInput: Record<string, unknown>;
  }): Promise<void> => {
    if (!policy) return;
    const evaluation = await policy.evaluate(opts.rawSpec);
    if (evaluation.blocking.length === 0) return;
    const pendingPublishId = uuid();
    await store.pendingPublishes.insert({
      id: pendingPublishId,
      provider_id: opts.providerId,
      raw_spec: opts.rawSpec,
      publish_input: opts.publishInput,
      exception_request_id: null,
      created_at: new Date().toISOString(),
    });
    throw new ApiError(422, 'POLICY_VIOLATION', 'OpenAPI document violates governance policy', {
      violations: evaluation.violations,
      pendingPublishId,
    });
  };

  const publishNormalized = async (opts: {
    providerId: string;
    input: PublishInput;
    meta: Awaited<ReturnType<typeof normalizeAndExtractMetadata>>;
    actor?: AuditActor | null;
    policyExceptionId?: string | null;
  }): Promise<ApiAsset> => {
    const { providerId, input, meta, actor, policyExceptionId } = opts;
    const namespace = input.namespace ?? config.ferrum.defaultNamespace;
    const created = await ferrum.createApiSpec(meta.rawSpec, meta.rawContentType, namespace);
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
      contact_name: meta.contact?.name ?? null,
      contact_email: input.contactEmail ?? meta.contact?.email ?? null,
      contact_url: meta.contact?.url ?? null,
      support_notes: input.supportNotes ?? null,
      operation_count: meta.operationCount,
      content_hash: meta.contentHash,
      ...factColumns(meta),
      policy_exception_id: policyExceptionId ?? null,
      created_at: now,
      updated_at: now,
    });
    await store.apiSpecVersions.insert({
      id: uuid(),
      api_asset_id: id,
      version: meta.version,
      content_hash: meta.contentHash,
      submitted_by: providerId,
      raw_spec: meta.rawSpec,
      created_at: now,
    });
    if (input.requestable) {
      await ensureAccessControlPlugin(id);
    }
    await audit.record(null, {
      action: policyExceptionId ? 'api.publish_with_exception' : 'api.publish',
      targetType: 'api_asset',
      targetId: id,
      after: {
        title: meta.title,
        version: meta.version,
        requestable: input.requestable,
        policyExceptionId,
      },
      actor,
    });
    return toApi(row);
  };

  const publish: PublishingService['publish'] = async ({ providerId, input, actor }) => {
    const meta = await normalizeAndExtractMetadata(input.rawSpec);
    const { rawSpec: _rawSpec, ...stageInput } = input;
    await enforcePolicyOrStage({
      providerId,
      rawSpec: meta.rawSpec,
      publishInput: { ...stageInput, mode: 'publish' },
    });
    return publishNormalized({ providerId, input, meta, actor });
  };

  const replaceNormalized = async (opts: {
    providerId: string;
    assetId: string;
    meta: Awaited<ReturnType<typeof normalizeAndExtractMetadata>>;
    actor?: AuditActor | null;
    policyExceptionId?: string | null;
  }): Promise<ApiAsset> => {
    const { providerId, assetId, meta, actor, policyExceptionId } = opts;
    const existing = await store.apiAssets.findById(assetId);
    if (!existing) throw notFound('API asset not found');
    if (existing.provider_id !== providerId) throw forbidden('Not the API owner');
    const updatedEdge = await ferrum.replaceApiSpec(
      existing.api_spec_id,
      meta.rawSpec,
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
      contact_name: meta.contact?.name ?? null,
      contact_email: existing.contact_email ?? meta.contact?.email ?? null,
      contact_url: meta.contact?.url ?? null,
      ...factColumns(meta),
      policy_exception_id: policyExceptionId ?? existing.policy_exception_id,
    });
    await store.apiSpecVersions.insert({
      id: uuid(),
      api_asset_id: assetId,
      version: meta.version,
      content_hash: meta.contentHash,
      submitted_by: providerId,
      raw_spec: meta.rawSpec,
      created_at: new Date().toISOString(),
    });
    if (next.requestable === 1) {
      await ensureAccessControlPlugin(assetId);
    }
    await audit.record(null, {
      action: policyExceptionId ? 'api.publish_with_exception' : 'api.spec_replace',
      targetType: 'api_asset',
      targetId: assetId,
      before: { version: existing.version, contentHash: existing.content_hash },
      after: { version: meta.version, contentHash: meta.contentHash, policyExceptionId },
      actor,
    });
    return toApi(next);
  };

  const replaceSpec: PublishingService['replaceSpec'] = async ({
    providerId,
    assetId,
    rawSpec,
    actor,
  }) => {
    const existing = await store.apiAssets.findById(assetId);
    if (!existing) throw notFound('API asset not found');
    if (existing.provider_id !== providerId) throw forbidden('Not the API owner');
    const meta = await normalizeAndExtractMetadata(rawSpec);
    await enforcePolicyOrStage({
      providerId,
      rawSpec: meta.rawSpec,
      publishInput: { mode: 'replace', assetId },
    });
    return replaceNormalized({ providerId, assetId, meta, actor });
  };

  const updateSettings: PublishingService['updateSettings'] = async ({
    providerId,
    assetId,
    patch,
    actor,
  }) => {
    const existing = await store.apiAssets.findById(assetId);
    if (!existing) throw notFound('API asset not found');
    if (existing.provider_id !== providerId) throw forbidden('Not the API owner');
    const next = await store.apiAssets.update(assetId, {
      visibility: (patch.visibility ?? existing.visibility) as ApiVisibility,
      requestable:
        patch.requestable == null ? existing.requestable : patch.requestable ? 1 : 0,
      lifecycle: (patch.lifecycle ?? existing.lifecycle) as ApiLifecycleStatus,
      contact_name: existing.contact_name,
      contact_email: patch.contactEmail === undefined ? existing.contact_email : patch.contactEmail,
      contact_url: existing.contact_url,
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
      actor,
    });
    return toApi(next);
  };

  const deleteAsset: PublishingService['deleteAsset'] = async ({ actorId, assetId, actor }) => {
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
      actor,
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
    actor,
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
      contact_name: spec.contact?.name ?? meta?.contact?.name ?? null,
      contact_email: spec.contact?.email ?? meta?.contact?.email ?? null,
      contact_url: spec.contact?.url ?? meta?.contact?.url ?? null,
      support_notes: null,
      operation_count: spec.operation_count ?? meta?.operationCount ?? 0,
      content_hash: spec.content_hash ?? meta?.contentHash ?? null,
      ...(meta
        ? factColumns(meta)
        : {
            proxy_hosts: [],
            proxy_paths: [],
            proxy_upstream_url: null,
            timeout_connect_ms: null,
            timeout_read_ms: null,
            timeout_write_ms: null,
            body_size_limit_bytes: null,
            rate_limit_per_minute: null,
            operation_paths: [],
            operation_summaries: [],
            source_format: 'openapi3' as const,
            policy_exception_id: null,
          }),
      created_at: now,
      updated_at: now,
    });
    await audit.record(null, {
      action: 'api.import',
      targetType: 'api_asset',
      targetId: id,
      after: { title: spec.title, specId, namespace },
      actor,
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

  const publishStaged: PublishingService['publishStaged'] = async ({
    pendingPublishId,
    exception,
    actor,
  }) => {
    const pending = await store.pendingPublishes.findById(pendingPublishId);
    if (!pending) throw notFound('Pending publish not found');
    if (exception.pending_publish_id !== pendingPublishId) {
      throw badRequest('exception_mismatch', 'Exception does not match pending publish');
    }
    if (policy) {
      const evaluation = await policy.evaluateWithException(pending.raw_spec, exception);
      if (evaluation.blocking.length > 0) {
        throw new ApiError(422, 'POLICY_VIOLATION', 'OpenAPI document still violates policy', {
          violations: evaluation.violations,
          pendingPublishId,
        });
      }
    }
    const meta = await normalizeAndExtractMetadata(pending.raw_spec);
    const mode = pending.publish_input.mode;
    const asset =
      mode === 'replace' && typeof pending.publish_input.assetId === 'string'
        ? await replaceNormalized({
            providerId: pending.provider_id,
            assetId: pending.publish_input.assetId,
            meta,
            actor,
            policyExceptionId: exception.id,
          })
        : await publishNormalized({
            providerId: pending.provider_id,
            input: PublishInput.parse({ ...pending.publish_input, rawSpec: pending.raw_spec }),
            meta,
            actor,
            policyExceptionId: exception.id,
          });
    await store.policyExceptions.update(exception.id, { api_asset_id: asset.id });
    await store.pendingPublishes.delete(pendingPublishId);
    return asset;
  };

  return {
    publish,
    replaceSpec,
    updateSettings,
    deleteAsset,
    ensureAccessControlPlugin,
    importFromEdge,
    syncFromEdge,
    publishStaged,
  };
}

function safeMeta(raw: string): ReturnType<typeof extractMetadata> | null {
  try {
    return extractMetadata(raw);
  } catch {
    return null;
  }
}
