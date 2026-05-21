import type { NexusStore } from '../db/store.js';
import type { AccessGrant } from '@ferrum-nexus/shared';

export interface GrantsService {
  listForClient(userId: string): Promise<AccessGrant[]>;
  listForAsset(assetId: string): Promise<AccessGrant[]>;
}

export function createGrantsService(store: NexusStore): GrantsService {
  const toApi = (row: {
    id: string;
    api_asset_id: string;
    client_user_id: string;
    client_consumer_id: string;
    acl_group: string;
    status: 'active' | 'revoked';
    approved_at: string;
    revoked_at: string | null;
    revoked_reason: string | null;
  }): AccessGrant => ({
    id: row.id,
    apiAssetId: row.api_asset_id,
    clientUserId: row.client_user_id,
    clientConsumerId: row.client_consumer_id,
    aclGroup: row.acl_group,
    status: row.status,
    approvedAt: row.approved_at,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
  });

  return {
    async listForClient(userId) {
      const rows = await store.grants.listForClient(userId);
      return rows.map(toApi);
    },
    async listForAsset(assetId) {
      const rows = await store.grants.listForAsset(assetId);
      return rows.map(toApi);
    },
  };
}
