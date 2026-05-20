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

const RECIPIENT_PAGE_SIZE = 500;

/**
 * Stream all rows matching a filtered users query in fixed-size pages. Avoids
 * loading the entire user table into memory (the previous implementation
 * pulled up to 100k rows in one shot, then did one role lookup per row).
 */
async function* paginateUsers(
  store: NexusStore,
  filter: { role?: 'client' | 'provider'; status?: 'pending' | 'active' | 'disabled' },
): AsyncGenerator<{ id: string; email: string }, void, void> {
  let offset = 0;
  while (true) {
    const { rows } = await store.users.listFiltered({
      role: filter.role,
      status: filter.status,
      limit: RECIPIENT_PAGE_SIZE,
      offset,
    });
    if (rows.length === 0) return;
    for (const row of rows) yield { id: row.id, email: row.email };
    if (rows.length < RECIPIENT_PAGE_SIZE) return;
    offset += rows.length;
  }
}

async function resolveRecipients(
  store: NexusStore,
  filter: z.infer<typeof MassEmailInput>['filter'],
): Promise<{ id: string; email: string }[]> {
  const recipients: { id: string; email: string }[] = [];
  switch (filter.audience) {
    case 'all_users':
      for await (const u of paginateUsers(store, {})) recipients.push(u);
      return recipients;
    case 'clients':
      for await (const u of paginateUsers(store, { role: 'client' })) recipients.push(u);
      return recipients;
    case 'providers':
      for await (const u of paginateUsers(store, { role: 'provider' })) recipients.push(u);
      return recipients;
    case 'pending_clients':
      for await (const u of paginateUsers(store, { status: 'pending', role: 'client' })) {
        recipients.push(u);
      }
      return recipients;
    case 'api_clients': {
      if (!filter.apiAssetId) return [];
      const grants = await store.grants.listForAsset(filter.apiAssetId);
      for (const grant of grants) {
        if (grant.status !== 'active') continue;
        const user = await store.users.findById(grant.client_user_id);
        if (user) recipients.push({ id: user.id, email: user.email });
      }
      return recipients;
    }
    default:
      return [];
  }
}
