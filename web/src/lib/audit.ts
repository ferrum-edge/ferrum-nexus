import type { AuditLog } from '@ferrum-nexus/shared';

/** Only rows with no actor id represent system or anonymous activity. */
export function auditActorLabel(entry: Pick<AuditLog, 'actor' | 'actor_user_id'>): string {
  if (entry.actor_user_id === null) return 'system';
  return entry.actor?.display_name ?? `Unknown user (${entry.actor_user_id})`;
}
