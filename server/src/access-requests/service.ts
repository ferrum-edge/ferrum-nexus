import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import type { NexusStore } from '../db/store.js';
import type { ResolvedConfig } from '../config/index.js';
import type { AccessRequest, AccessRequestStatus } from '@ferrum-nexus/shared';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import type { CredentialsService } from '../credentials/service.js';
import type { AuditService } from '../audit/service.js';
import type { NotificationService } from '../notifications/service.js';
import type { EmailService } from '../email/service.js';
import { aclGroupForApi } from '@ferrum-nexus/shared';

export const RequestInput = z.object({
  justification: z.string().min(10).max(2000),
});

export const ApproveInput = z.object({
  providerReason: z.string().max(2000).optional(),
});

export const DenyInput = z.object({
  providerReason: z.string().min(1).max(2000),
});

export const RevokeInput = z.object({
  reason: z.string().min(1).max(2000),
});

export interface AccessRequestsService {
  create(opts: {
    clientUserId: string;
    clientEmail: string;
    clientName: string | null;
    apiAssetId: string;
    justification: string;
  }): Promise<AccessRequest>;
  approve(opts: {
    providerId: string;
    requestId: string;
    providerReason: string | null;
  }): Promise<{ request: AccessRequest; grantId: string }>;
  deny(opts: { providerId: string; requestId: string; providerReason: string }): Promise<AccessRequest>;
  revoke(opts: { providerId: string; grantId: string; reason: string }): Promise<void>;
  listForClient(userId: string): Promise<AccessRequest[]>;
  listForProvider(providerId: string, status?: AccessRequestStatus): Promise<AccessRequest[]>;
  godRevoke(opts: { actorId: string; grantId: string; reason: string }): Promise<void>;
}

export function createAccessRequestsService(
  config: ResolvedConfig,
  store: NexusStore,
  credentials: CredentialsService,
  audit: AuditService,
  notifications: NotificationService,
  email: EmailService,
): AccessRequestsService {
  const toApi = (row: {
    id: string;
    api_asset_id: string;
    client_user_id: string;
    client_consumer_id: string | null;
    justification: string;
    status: AccessRequestStatus;
    provider_reason: string | null;
    reviewed_by: string | null;
    created_at: string;
    reviewed_at: string | null;
  }): AccessRequest => ({
    id: row.id,
    apiAssetId: row.api_asset_id,
    clientUserId: row.client_user_id,
    clientConsumerId: row.client_consumer_id,
    justification: row.justification,
    status: row.status,
    providerReason: row.provider_reason,
    reviewedBy: row.reviewed_by,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
  });

  const create: AccessRequestsService['create'] = async ({
    clientUserId,
    clientEmail,
    clientName,
    apiAssetId,
    justification,
  }) => {
    const asset = await store.apiAssets.findById(apiAssetId);
    if (!asset) throw notFound('API asset not found');
    if (asset.requestable !== 1) {
      throw badRequest('not_requestable', 'This API is not currently accepting access requests');
    }
    const existing = await store.accessRequests.findOpenFor(clientUserId, apiAssetId);
    if (existing) throw conflict('request_pending', 'You already have a pending request for this API');

    const consumerId = await credentials.ensureConsumerForUser({
      userId: clientUserId,
      email: clientEmail,
      name: clientName,
      namespace: asset.namespace,
    });

    const row = await store.accessRequests.insert({
      id: uuid(),
      api_asset_id: apiAssetId,
      client_user_id: clientUserId,
      client_consumer_id: consumerId,
      justification,
      status: 'pending',
      provider_reason: null,
      reviewed_by: null,
      created_at: new Date().toISOString(),
      reviewed_at: null,
    });

    const conv = await store.conversations.insert({
      id: uuid(),
      api_asset_id: apiAssetId,
      request_id: row.id,
      grant_id: null,
      type: 'access_request',
      subject: `Access request: ${asset.title}`,
      participants: [clientUserId, asset.provider_id],
      created_at: new Date().toISOString(),
    });

    await notifications.push({
      recipientId: asset.provider_id,
      type: 'access_request_created',
      payload: {
        requestId: row.id,
        apiAssetId,
        apiTitle: asset.title,
        conversationId: conv.id,
      },
    });
    const provider = await store.users.findById(asset.provider_id);
    if (provider) {
      await email.enqueue({
        to: provider.email,
        templateKey: 'access_request_created',
        vars: {
          apiTitle: asset.title,
          clientName: clientName ?? clientEmail,
          clientEmail,
          justification,
          reviewUrl: `${config.publicUrl}/provider/requests/${row.id}`,
        },
      });
    }

    await audit.record(null, {
      action: 'access_request.create',
      targetType: 'access_request',
      targetId: row.id,
      after: { apiAssetId, clientUserId },
    });

    return toApi(row);
  };

  const ensureProviderOwnsAsset = async (providerId: string, assetId: string): Promise<void> => {
    const asset = await store.apiAssets.findById(assetId);
    if (!asset) throw notFound('API asset not found');
    if (asset.provider_id !== providerId) throw forbidden('Not the API owner');
  };

  const approve: AccessRequestsService['approve'] = async ({
    providerId,
    requestId,
    providerReason,
  }) => {
    const request = await store.accessRequests.findById(requestId);
    if (!request) throw notFound('Request not found');
    if (request.status !== 'pending') {
      throw badRequest('not_pending', 'Request is not in a pending state');
    }
    await ensureProviderOwnsAsset(providerId, request.api_asset_id);
    if (!request.client_consumer_id) throw badRequest('no_consumer', 'Client consumer missing');

    await credentials.syncAclGroupsForGrant({
      consumerId: request.client_consumer_id,
      apiAssetId: request.api_asset_id,
      add: true,
    });

    const grant = await store.grants.insert({
      id: uuid(),
      api_asset_id: request.api_asset_id,
      client_user_id: request.client_user_id,
      client_consumer_id: request.client_consumer_id,
      acl_group: aclGroupForApi(request.api_asset_id),
      status: 'active',
      approved_by: providerId,
      approved_at: new Date().toISOString(),
      revoked_by: null,
      revoked_at: null,
      revoked_reason: null,
    });

    const updated = await store.accessRequests.update(requestId, {
      status: 'approved',
      provider_reason: providerReason,
      reviewed_by: providerId,
      reviewed_at: new Date().toISOString(),
    });

    const asset = await store.apiAssets.findById(request.api_asset_id);
    const client = await store.users.findById(request.client_user_id);
    await notifications.push({
      recipientId: request.client_user_id,
      type: 'access_request_approved',
      payload: { requestId, apiTitle: asset?.title, providerReason },
    });
    if (client) {
      await email.enqueue({
        to: client.email,
        templateKey: 'access_request_approved',
        vars: {
          apiTitle: asset?.title ?? 'an API',
          providerReason: providerReason ?? '',
          accessUrl: `${config.publicUrl}/client/access`,
        },
      });
    }
    await audit.record(null, {
      action: 'access_request.approve',
      targetType: 'access_request',
      targetId: requestId,
      after: { grantId: grant.id, providerReason },
    });

    return { request: toApi(updated), grantId: grant.id };
  };

  const deny: AccessRequestsService['deny'] = async ({ providerId, requestId, providerReason }) => {
    const request = await store.accessRequests.findById(requestId);
    if (!request) throw notFound('Request not found');
    if (request.status !== 'pending') {
      throw badRequest('not_pending', 'Request is not in a pending state');
    }
    await ensureProviderOwnsAsset(providerId, request.api_asset_id);
    const updated = await store.accessRequests.update(requestId, {
      status: 'denied',
      provider_reason: providerReason,
      reviewed_by: providerId,
      reviewed_at: new Date().toISOString(),
    });
    const asset = await store.apiAssets.findById(request.api_asset_id);
    const client = await store.users.findById(request.client_user_id);
    await notifications.push({
      recipientId: request.client_user_id,
      type: 'access_request_denied',
      payload: { requestId, apiTitle: asset?.title, providerReason },
    });
    if (client) {
      await email.enqueue({
        to: client.email,
        templateKey: 'access_request_denied',
        vars: { apiTitle: asset?.title ?? 'an API', providerReason },
      });
    }
    await audit.record(null, {
      action: 'access_request.deny',
      targetType: 'access_request',
      targetId: requestId,
      after: { providerReason },
    });
    return toApi(updated);
  };

  const revokeInternal = async (
    grantId: string,
    actorId: string,
    reason: string,
    asGod: boolean,
  ): Promise<void> => {
    const grant = await store.grants.findById(grantId);
    if (!grant || grant.status !== 'active') throw notFound('Active grant not found');
    const asset = await store.apiAssets.findById(grant.api_asset_id);
    if (!asGod && asset && asset.provider_id !== actorId) {
      throw forbidden('Not the API owner');
    }
    await credentials.syncAclGroupsForGrant({
      consumerId: grant.client_consumer_id,
      apiAssetId: grant.api_asset_id,
      add: false,
    });
    await store.grants.update(grantId, {
      status: 'revoked',
      revoked_by: actorId,
      revoked_at: new Date().toISOString(),
      revoked_reason: reason,
    });
    const client = await store.users.findById(grant.client_user_id);
    await notifications.push({
      recipientId: grant.client_user_id,
      type: 'access_revoked',
      payload: { grantId, apiTitle: asset?.title, reason },
    });
    if (client) {
      await email.enqueue({
        to: client.email,
        templateKey: 'access_revoked',
        vars: { apiTitle: asset?.title ?? 'an API', reason },
      });
    }
    await audit.record(null, {
      action: asGod ? 'admin.god_revoke' : 'access_grant.revoke',
      targetType: 'access_grant',
      targetId: grantId,
      reason,
    });
  };

  return {
    create,
    approve,
    deny,
    async revoke({ providerId, grantId, reason }) {
      await revokeInternal(grantId, providerId, reason, false);
    },
    async godRevoke({ actorId, grantId, reason }) {
      await revokeInternal(grantId, actorId, reason, true);
    },
    async listForClient(userId) {
      const rows = await store.accessRequests.listForClient(userId);
      return rows.map(toApi);
    },
    async listForProvider(providerId, status) {
      const rows = await store.accessRequests.listForProvider(providerId, status);
      return rows.map(toApi);
    },
  };
}
