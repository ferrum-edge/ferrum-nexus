import { v4 as uuid } from 'uuid';
import type { FastifyRequest } from 'fastify';
import type { NexusStore } from '../db/store.js';
import type { AuditLogEntry } from '@ferrum-nexus/shared';

export interface AuditRecord {
  action: string;
  targetType: string;
  targetId?: string | null;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
}

export interface AuditService {
  record(req: FastifyRequest | null, record: AuditRecord): Promise<void>;
  list(opts: {
    limit?: number;
    offset?: number;
    action?: string;
    actorId?: string;
  }): Promise<{ rows: AuditLogEntry[]; total: number }>;
}

export function createAuditService(store: NexusStore): AuditService {
  return {
    async record(req, record) {
      await store.audit.insert({
        id: uuid(),
        actor_id: req?.auth?.id ?? null,
        actor_email: req?.auth?.email ?? null,
        action: record.action,
        target_type: record.targetType,
        target_id: record.targetId ?? null,
        reason: record.reason ?? null,
        before: record.before ?? null,
        after: record.after ?? null,
        ip: (req?.ip as string) ?? null,
        user_agent: (req?.headers['user-agent'] as string | undefined) ?? null,
        created_at: new Date().toISOString(),
      });
    },
    async list(opts) {
      const { rows, total } = await store.audit.list(opts);
      return {
        rows: rows.map((row) => ({
          id: row.id,
          actorId: row.actor_id,
          actorEmail: row.actor_email,
          action: row.action,
          targetType: row.target_type,
          targetId: row.target_id,
          reason: row.reason,
          before: row.before,
          after: row.after,
          ip: row.ip,
          userAgent: row.user_agent,
          createdAt: row.created_at,
        })),
        total,
      };
    },
  };
}
