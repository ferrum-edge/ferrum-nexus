import { v4 as uuid } from 'uuid';
import type { NexusStore } from '../db/store.js';
import type { Organization, UserStatus } from '@ferrum-nexus/shared';

export interface OrganizationsService {
  create(input: { name: string; domain?: string }): Promise<Organization>;
  list(): Promise<Organization[]>;
  addMember(opts: { orgId: string; userId: string; role?: 'member' | 'owner' }): Promise<void>;
  membersOf(orgId: string): Promise<{ userId: string; role: 'member' | 'owner' }[]>;
}

export function createOrganizationsService(store: NexusStore): OrganizationsService {
  const toApi = (row: {
    id: string;
    name: string;
    domain: string | null;
    status: UserStatus;
    created_at: string;
  }): Organization => ({
    id: row.id,
    name: row.name,
    domain: row.domain,
    status: row.status,
    createdAt: row.created_at,
  });

  return {
    async create({ name, domain }) {
      const row = await store.organizations.insert({
        id: uuid(),
        name,
        domain: domain ?? null,
        status: 'active',
        created_at: new Date().toISOString(),
      });
      return toApi(row);
    },
    async list() {
      const rows = await store.organizations.list();
      return rows.map(toApi);
    },
    async addMember({ orgId, userId, role = 'member' }) {
      await store.organizations.addMember({
        organization_id: orgId,
        user_id: userId,
        role,
        created_at: new Date().toISOString(),
      });
    },
    async membersOf(orgId) {
      const rows = await store.organizations.membersOf(orgId);
      return rows.map((row) => ({ userId: row.user_id, role: row.role }));
    },
  };
}
