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
  actor?: AuditActor | null;
}

export interface AuditActor {
  id: string | null;
  email: string | null;
  ip: string | null;
  userAgent: string | null;
}

// Field names that look like secrets — these get redacted before insert so an
// audit log inspector (or backup) cannot recover credentials, tokens, or
// SMTP passwords from the historical record. Match is case-insensitive and
// substring-based so `apiKey`, `api_key`, `SMTP_PASSWORD`, `client_secret`,
// `bearerToken`, `data.secret`, etc. are all caught.
const SECRET_FIELD_PATTERN = /(password|secret|token|api[_-]?key|client[_-]?id|private[_-]?key|certificate|cert)/i;
const REDACTED = '[REDACTED]';

function scrubValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return value; // bounded recursion for cyclic-ish payloads
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_FIELD_PATTERN.test(k) ? REDACTED : scrubValue(v, depth + 1);
    }
    return out;
  }
  return value;
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
      const actor = req ? auditActorFromRequest(req) : record.actor ?? null;
      await store.audit.insert({
        id: uuid(),
        actor_id: actor?.id ?? null,
        actor_email: actor?.email ?? null,
        action: record.action,
        target_type: record.targetType,
        target_id: record.targetId ?? null,
        reason: record.reason ?? null,
        before: record.before == null ? null : scrubValue(record.before),
        after: record.after == null ? null : scrubValue(record.after),
        ip: actor?.ip ?? null,
        user_agent: actor?.userAgent ?? null,
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

export function auditActorFromRequest(req: FastifyRequest): AuditActor {
  return {
    id: req.auth?.id ?? null,
    email: req.auth?.email ?? null,
    ip: (req.ip as string) ?? null,
    userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
  };
}
