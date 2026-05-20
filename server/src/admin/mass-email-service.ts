import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import type { NexusStore } from '../db/store.js';
import type { EmailService } from '../email/service.js';

export const MassEmailInput = z.object({
  subject: z.string().min(1).max(255),
  body: z.string().min(1).max(20_000),
  filter: z.object({
    audience: z.enum([
      'all_users',
      'clients',
      'providers',
      'pending_clients',
      'api_clients',
    ]),
    apiAssetId: z.string().optional(),
    userIds: z.array(z.string()).optional(),
  }),
});

export interface MassEmailService {
  send(opts: {
    actorId: string;
    input: z.infer<typeof MassEmailInput>;
  }): Promise<{ campaignId: string; queued: number }>;
  list(): Promise<
    Awaited<ReturnType<NexusStore['massEmail']['list']>>
  >;
}

export function createMassEmailService(
  store: NexusStore,
  email: EmailService,
): MassEmailService {
  return {
    async send({ actorId, input }) {
      const recipients = await resolveRecipients(store, input.filter);
      const campaign = await store.massEmail.insert({
        id: uuid(),
        created_by: actorId,
        recipient_filter: input.filter,
        subject: input.subject,
        body: input.body,
        status: 'running',
        sent_count: 0,
        failed_count: 0,
        created_at: new Date().toISOString(),
        completed_at: null,
      });
      for (const recipient of recipients) {
        await email.enqueue({
          to: recipient.email,
          templateKey: 'admin_broadcast',
          vars: { subject: input.subject, body: input.body },
        });
      }
      await store.massEmail.update(campaign.id, {
        status: 'completed',
        sent_count: recipients.length,
        completed_at: new Date().toISOString(),
      });
      return { campaignId: campaign.id, queued: recipients.length };
    },
    async list() {
      return store.massEmail.list();
    },
  };
}

async function resolveRecipients(
  store: NexusStore,
  filter: z.infer<typeof MassEmailInput>['filter'],
): Promise<{ id: string; email: string }[]> {
  switch (filter.audience) {
    case 'all_users': {
      const { rows } = await store.users.list({ limit: 100_000 });
      return rows.map((r) => ({ id: r.id, email: r.email }));
    }
    case 'clients': {
      const { rows } = await store.users.list({ limit: 100_000 });
      const filtered: { id: string; email: string }[] = [];
      for (const row of rows) {
        const roles = await store.userRoles.forUser(row.id);
        if (roles.includes('client')) filtered.push({ id: row.id, email: row.email });
      }
      return filtered;
    }
    case 'providers': {
      const { rows } = await store.users.list({ limit: 100_000 });
      const filtered: { id: string; email: string }[] = [];
      for (const row of rows) {
        const roles = await store.userRoles.forUser(row.id);
        if (roles.includes('provider')) filtered.push({ id: row.id, email: row.email });
      }
      return filtered;
    }
    case 'pending_clients': {
      const { rows } = await store.users.list({ limit: 100_000 });
      return rows
        .filter((r) => r.status === 'pending')
        .map((r) => ({ id: r.id, email: r.email }));
    }
    case 'api_clients': {
      if (!filter.apiAssetId) return [];
      const grants = await store.grants.listForAsset(filter.apiAssetId);
      const out: { id: string; email: string }[] = [];
      for (const grant of grants) {
        if (grant.status !== 'active') continue;
        const user = await store.users.findById(grant.client_user_id);
        if (user) out.push({ id: user.id, email: user.email });
      }
      return out;
    }
    default:
      return [];
  }
}
