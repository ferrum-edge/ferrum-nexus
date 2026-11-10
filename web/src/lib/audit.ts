import type { AuditLog } from '@ferrum-nexus/shared';

/** Only rows with no actor id represent system or anonymous activity. */
export function auditActorLabel(entry: Pick<AuditLog, 'actor' | 'actor_user_id'>): string {
  if (entry.actor_user_id === null) return 'system';
  return entry.actor?.display_name ?? `Unknown user (${entry.actor_user_id})`;
}

/** How an audit row is coloured, by what its action did. */
export type AuditTone = 'warning' | 'danger' | 'success' | 'neutral';

/** An operation that did not finish, was undone, or waits on someone. */
const WARNING_WORDS: ReadonlySet<string> = new Set([
  'rollback',
  'fail',
  'failed',
  'required',
  'stalled',
]);
const DANGER_WORDS: ReadonlySet<string> = new Set([
  'delete',
  'revoke',
  'deny',
  'denied',
  'disable',
  'remove',
  'teardown',
  'purge',
  'reject',
]);
const SUCCESS_WORDS: ReadonlySet<string> = new Set([
  'approve',
  'create',
  'grant',
  'publish',
  'issue',
  'register',
  'enable',
  'add',
  'repair',
  'restore',
]);

/**
 * Colour an audit action by what it did, read off its own name.
 *
 * The catalog lives on the server and grows with every feature, so the tone is
 * derived from the words of the action rather than from a table the browser
 * would have to be taught about; an unrecognised action is neutral. Words are
 * whole `.`/`_`-delimited tokens, so `user.address_release` is not an `add`.
 * A rollback, failure or pending repair outranks the verb it qualifies
 * (`access.approve_rollback` undid an approval), and a destructive verb
 * outranks a constructive one (`god.revoke_grant`).
 */
export function auditTone(action: string): AuditTone {
  const words = action.split(/[._]/);
  if (words.some((word) => WARNING_WORDS.has(word))) return 'warning';
  if (words.some((word) => DANGER_WORDS.has(word))) return 'danger';
  if (words.some((word) => SUCCESS_WORDS.has(word))) return 'success';
  return 'neutral';
}
