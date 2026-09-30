/**
 * Telling an API's grantees that its specification changed (issue #447).
 *
 * When a revision replaces another and the comparison found a difference,
 * every account holding an active grant on the API — once, however many of
 * its identities hold one — gets an in-app notice and an email summarising
 * what changed, linking to the catalog page's Changes tab (#448). The account
 * that published the revision is not told about its own change.
 *
 * ## What keeps it from being noise
 *
 * - **Only real changes.** An identical re-upload changes nothing and sends
 *   nothing.
 * - **Preferences.** Each channel can be turned off per account
 *   (`user_notification_preferences`); an account with no row gets both.
 * - **Coalescing.** An account that still has an unread notice for the API's
 *   history is not given a second one: the one it has already links to every
 *   revision since. Email is coalesced by time instead, because a sent email
 *   cannot be marked read: one per API per recipient per
 *   `SPEC_CHANGE_EMAIL_WINDOW_MS`, through the outbox's idempotency key, so a
 *   provider publishing ten revisions in an afternoon sends at most a few.
 *
 * ## Best-effort, after the fact
 *
 * The revision has committed by the time this runs, and a notification that
 * fails must never fail or undo a publish, so {@link SpecChangeNotifier.notify}
 * never throws: a failure is logged. The notices and emails of one batch
 * commit together with the `api.spec_notify` audit row that counts them, so
 * the fan-out is never half recorded. Each body is plain text built from the
 * stored change summary; the email template escapes it like every other value.
 */

import {
  SPEC_CHANGE_EMAIL_WINDOW_MS,
  SPEC_CHANGE_NOTICE_NAMED,
  describeSpecChange,
  type ApiSpecChangeEntry,
  type Role,
  type SpecChange,
  type Uuid,
} from '@ferrum-nexus/shared';

import { AuditAction, type AuditService } from '../audit/service.js';
import type { NexusConfig } from '../config/index.js';
import type { ApiRecord, NexusStore } from '../db/store.js';
import type { EmailService } from '../email/service.js';

/** Recipients handled per transaction, so one fan-out never holds a long one. */
export const SPEC_CHANGE_NOTICE_BATCH = 200;

/** What a spec-change notice says, in plain text. */
export interface SpecChangeNotice {
  /** `updated to 2.0.0`, or `rolled back to 1.0.0`. */
  headline: string;
  /** `<API name> spec updated to 2.0.0`: the notice's title and the email's subject. */
  title: string;
  /** Counts in a sentence or two, plus the caveats. */
  summary: string;
  /** The named changes, removed operations first, then `and N more`. */
  lines: string[];
  /** The in-app body: the summary and the named changes. */
  body: string;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** One change as a line that says which operation it is in. */
function changeLine(change: SpecChange): string {
  if (change.kind === 'operation_removed' && change.operation) {
    const { method, path } = change.operation;
    return `Removed: ${method} ${path} (requests to removed operations may now fail)`;
  }
  const text = describeSpecChange(change);
  return change.operation ? `${change.operation.method} ${change.operation.path}: ${text}` : text;
}

/**
 * What to tell grantees about one recorded change. Pure, and bounded by the
 * summary it reads: at most {@link SPEC_CHANGE_NOTICE_NAMED} changes are named,
 * each already cut to `MAX_SPEC_CHANGE_TEXT` per name.
 */
export function summarizeSpecChange(apiName: string, entry: ApiSpecChangeEntry): SpecChangeNotice {
  const { report } = entry;
  const { counts } = report;
  const verb = entry.kind === 'rollback' ? 'rolled back to' : 'updated to';
  const headline = `${verb} ${entry.version}`;
  const total = counts.breaking + counts.non_breaking;

  const sentences: string[] = [];
  if (total === 0) {
    // Nothing structural: `changed` is set by an `info` field alone.
    const fields = report.info_changes;
    const named =
      fields.length > 1 ? `${fields.slice(0, -1).join(', ')} and ${fields.at(-1)}` : fields[0];
    sentences.push(
      named === undefined
        ? 'The comparison found no difference in its operations or schemas.'
        : `Only its ${named} changed.`,
    );
  } else {
    const operations = [
      [counts.operations_added, 'added'],
      [counts.operations_changed, 'changed'],
      [counts.operations_removed, 'removed'],
    ] as const;
    const parts: string[] = [];
    for (const [count, what] of operations) {
      if (count === 0) continue;
      parts.push(parts.length === 0 ? `${plural(count, 'operation')} ${what}` : `${count} ${what}`);
    }
    if (parts.length > 0) sentences.push(`${parts.join(', ')}.`);
    sentences.push(`${plural(total, 'change')} in all, ${counts.breaking} breaking.`);
  }
  if (!report.complete) {
    sentences.push('The comparison was incomplete, so this may not be everything.');
  }

  // Removed operations first: they are the changes a caller is most likely to
  // be hit by, and the ones the provider cannot take back once clients break.
  const removed = report.changes.filter((change) => change.kind === 'operation_removed');
  const others = report.changes.filter((change) => change.kind !== 'operation_removed');
  const named = [...removed, ...others].slice(0, SPEC_CHANGE_NOTICE_NAMED).map(changeLine);
  const more = total - named.length;
  const lines = more > 0 ? [...named, `and ${plural(more, 'more change')}`] : named;

  const caveat =
    'This compares the structure of the two documents, so a change it does not list can still ' +
    'affect you.';
  const summary = [...sentences, caveat].join(' ');
  const listed = lines.length > 0 ? [`${lines.join('; ')}.`] : [];
  const body = [...sentences, ...listed, caveat].join(' ');
  return { headline, title: `${apiName} spec ${headline}`, summary, lines, body };
}

/**
 * A line as the email carries it. Mail clients turn anything that looks like
 * a URL into a link, and a provider-written name is not a destination this
 * portal vouches for, so the scheme separator is broken up.
 */
export function specChangeEmailLine(line: string): string {
  return `- ${line.replace(/:\/\//g, '[:]//')}`;
}

/** Tells an API's grantees about a recorded spec change. */
export interface SpecChangeNotifier {
  /**
   * Notify the grantees of `api` of `change`, published by `actor`. Never
   * throws: the revision is already published, and a failure is logged.
   */
  notify(
    actor: { id: Uuid; role: Role },
    api: ApiRecord,
    change: ApiSpecChangeEntry,
    ip: string | null,
  ): Promise<void>;
}

/** Dependencies of {@link createSpecChangeNotifier}. */
export interface SpecChangeNotifierDeps {
  store: NexusStore;
  email: Pick<EmailService, 'prepareRenderer'>;
  audit: AuditService;
  config: Pick<NexusConfig, 'publicUrl'>;
  log?: (obj: Record<string, unknown>, message: string) => void;
  /** Clock for the email window; tests move it. */
  now?: () => number;
}

/** Build the spec-change notifier. */
export function createSpecChangeNotifier(deps: SpecChangeNotifierDeps): SpecChangeNotifier {
  const { store, email, audit, config } = deps;
  const now = deps.now ?? Date.now;

  async function fanOut(
    actor: { id: Uuid; role: Role },
    api: ApiRecord,
    change: ApiSpecChangeEntry,
    ip: string | null,
  ): Promise<void> {
    if (!change.report.changed) return;
    // One notice per account, however many of its identities hold a grant,
    // and none for the account that published the change.
    const grants = await store.grants.listActiveByApi(api.id);
    const holders = new Set(grants.map((grant) => grant.user_id));
    holders.delete(actor.id);
    const recipients = [...holders];
    if (recipients.length === 0) return;

    const link = `/catalog/${encodeURIComponent(api.slug)}?tab=changes`;
    const notice = summarizeSpecChange(api.name, change);
    const changes = notice.lines.map(specChangeEmailLine).join('\n');
    const render = await email.prepareRenderer('spec_updated');
    const window = Math.floor(now() / SPEC_CHANGE_EMAIL_WINDOW_MS);
    const batches = Math.ceil(recipients.length / SPEC_CHANGE_NOTICE_BATCH);

    for (let batch = 0; batch < batches; batch += 1) {
      const ids = recipients.slice(
        batch * SPEC_CHANGE_NOTICE_BATCH,
        (batch + 1) * SPEC_CHANGE_NOTICE_BATCH,
      );
      const found = await store.users.findManyByIds(ids);
      const users = found.filter((user) => user.status === 'active');
      if (users.length === 0) continue;
      const userIds = users.map((user) => user.id);
      const rows = await store.notificationPreferences.findManyByUsers(userIds);
      const preferences = new Map(rows.map((row) => [row.user_id, row]));
      const wantsInApp = users.filter(
        (user) => preferences.get(user.id)?.api_spec_updated_in_app !== false,
      );
      const wantsEmail = users.filter(
        (user) => preferences.get(user.id)?.api_spec_updated_email !== false,
      );
      const toldIds = await store.notifications.listUsersWithUnread(
        wantsInApp.map((user) => user.id),
        'api_spec_updated',
        link,
      );
      const alreadyTold = new Set(toldIds);
      const inApp = wantsInApp.filter((user) => !alreadyTold.has(user.id));
      // Rendered before the transaction: the renderer is pure, so a body that
      // is re-run on contention writes exactly the same rows.
      const mails = wantsEmail.map((user) => ({
        user,
        rendered: render({
          recipient_name: user.display_name,
          recipient_email: user.email,
          api_name: api.name,
          api_slug: api.slug,
          version: change.version,
          headline: notice.headline,
          summary: notice.summary,
          changes,
          changes_url: `${config.publicUrl}${link}`,
        }),
      }));

      await store.transaction(async (tx) => {
        let emailed = 0;
        for (const { user, rendered } of mails) {
          // At most once per API, recipient and window: a later revision in the
          // same window finds the row and queues nothing.
          const queued = await tx.emailOutbox.enqueue({
            to_email: user.email,
            subject: rendered.subject,
            body_html: rendered.html,
            body_text: rendered.text,
            idempotency_key: `spec-updated:${api.id}:${user.id}:${window}`,
          });
          if (queued.created) emailed += 1;
        }
        if (inApp.length > 0) {
          await tx.notifications.createMany(
            inApp.map((user) => ({
              user_id: user.id,
              type: 'api_spec_updated' as const,
              title: notice.title,
              body: notice.body,
              link,
            })),
          );
        }
        await audit.forStore(tx).record(
          actor,
          AuditAction.API_SPEC_NOTIFY,
          { type: 'api', id: api.id },
          {
            spec_id: change.revision_id,
            kind: change.kind,
            version: change.version,
            batch: batch + 1,
            batches,
            recipients: users.length,
            notified: inApp.length,
            already_notified: alreadyTold.size,
            opted_out_in_app: users.length - wantsInApp.length,
            emailed,
            email_coalesced: mails.length - emailed,
            opted_out_email: users.length - wantsEmail.length,
          },
          ip,
        );
      });
    }
  }

  return {
    async notify(actor, api, change, ip): Promise<void> {
      try {
        await fanOut(actor, api, change, ip);
      } catch (error) {
        deps.log?.(
          {
            api_id: api.id,
            spec_id: change.revision_id,
            error: error instanceof Error ? error.message : String(error),
          },
          'Could not notify grantees of a spec change; the revision itself is published',
        );
      }
    },
  };
}
