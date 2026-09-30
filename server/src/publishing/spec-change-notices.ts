/**
 * Telling an API's grantees that its specification changed (issue #447).
 *
 * When a revision replaces another and the comparison found a difference,
 * every account holding an active grant on the API — once, however many of
 * its identities hold one — gets an in-app notice summarising what changed,
 * linking to the catalog page's Changes tab (#448), and an email if it asked
 * for one. The account that published the revision is not told about its own
 * change.
 *
 * ## What keeps it from being noise
 *
 * - **Only real changes.** An identical re-upload changes nothing and sends
 *   nothing.
 * - **Preferences.** Each channel is chosen per account
 *   (`user_notification_preferences`). An account with no row gets the in-app
 *   notice and no email: email is opt-in, since #447 asked for the in-app
 *   channel and an email per revision is the noisier one.
 * - **Coalescing.** An account that still has an unread notice for the API's
 *   history is not given a second one: the one it has is rewritten to say what
 *   the newest revision changed, and links to every revision since. Email is
 *   coalesced by time instead, because a sent email cannot be marked read: at
 *   most one per API per recipient per clock hour, through the outbox's
 *   idempotency key.
 * - **A cap.** One fan-out queues at most `NEXUS_MAX_MASS_EMAIL_RECIPIENTS`
 *   emails, the ceiling a mass email has, so a large API cannot crowd
 *   verification and password-reset mail out of the outbox; everyone past it
 *   still gets the in-app notice.
 *
 * ## Best-effort, detached, after the fact
 *
 * The revision has committed by the time this runs, and the publish does not
 * wait for it: {@link SpecChangeNotifier.notify} is started and left to run,
 * and never rejects. A failure is logged, and a batch that fails does not stop
 * the next. Work in flight when the process stops is lost; nothing retries
 * it. The notices and emails of one batch commit together with the
 * `api.spec_notify` audit row that counts them, so a batch is never half
 * recorded. Each body is plain text built from the stored change summary, with
 * every provider-written value made inert as a link; the email template escapes
 * it like every other value.
 */

import {
  MAX_SPEC_CHANGE_TEXT,
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
import type { ApiRecord, NexusStore, UserRecord } from '../db/store.js';
import type { EmailService } from '../email/service.js';
import type { RenderedEmail } from '../email/templates.js';
import { clipSpecText } from './spec-changes.js';

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

/**
 * Provider-written text made inert as a link. Mail clients turn anything that
 * looks like `https://host` into one — and so does the portal's own check of a
 * rendered email, which refuses the whole message for an off-portal URL — so
 * the colon of every scheme separator, `//` or `\\` alike, is bracketed.
 */
export function inertText(text: string): string {
  return text.replace(/:(?=[/\\]{2})/g, '[:]');
}

/**
 * Provider-written text fit for a title or a subject: control characters and
 * line breaks collapsed to spaces, and cut to `MAX_SPEC_CHANGE_TEXT`.
 */
export function oneLine(text: string): string {
  return clipSpecText(
    text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim(),
    MAX_SPEC_CHANGE_TEXT,
  );
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
  // `version` defaults to the document's own `info.version`, which nothing
  // bounds, and it becomes a title and a subject: one line, cut.
  const headline = `${verb} ${oneLine(entry.version)}`;
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
  return { headline, title: `${oneLine(apiName)} spec ${headline}`, summary, lines, body };
}

/** A line as the email carries it: a list item, inert as a link. */
export function specChangeEmailLine(line: string): string {
  return `- ${inertText(line)}`;
}

/** Tells an API's grantees about a recorded spec change. */
export interface SpecChangeNotifier {
  /**
   * Notify the grantees of `api` of `change`, published by `actor`. The
   * returned promise never rejects — the revision is already published, and a
   * failure is logged — so a caller may leave it to run.
   */
  notify(
    actor: { id: Uuid; role: Role },
    api: ApiRecord,
    change: ApiSpecChangeEntry,
    ip: string | null,
  ): Promise<void>;
  /** Settles once every fan-out started so far has finished. */
  idle(): Promise<void>;
}

/** Dependencies of {@link createSpecChangeNotifier}. */
export interface SpecChangeNotifierDeps {
  store: NexusStore;
  email: Pick<EmailService, 'prepareRenderer'>;
  audit: AuditService;
  config: Pick<NexusConfig, 'publicUrl' | 'maxMassEmailRecipients'>;
  log?: (obj: Record<string, unknown>, message: string) => void;
  /** Clock for the email window; tests move it. */
  now?: () => number;
}

/** A prepared `spec_updated` renderer. */
type Renderer = Awaited<ReturnType<EmailService['prepareRenderer']>>;

/** Build the spec-change notifier. */
export function createSpecChangeNotifier(deps: SpecChangeNotifierDeps): SpecChangeNotifier {
  const { store, email, audit, config } = deps;
  const now = deps.now ?? Date.now;

  /** How many recipients one batch told, emailed, or skipped, and why. */
  interface BatchCounts {
    recipients: number;
    notified: number;
    already_notified: number;
    in_app_off: number;
    emailed: number;
    email_coalesced: number;
    email_off: number;
    email_capped: number;
    email_failed: number;
  }

  /** What one batch will write, read and rendered before its transaction. */
  interface BatchPlan {
    /** `null` when nobody in the batch is still a recipient. */
    counts: BatchCounts | null;
    /** Accounts getting a new notice. */
    inApp: Uuid[];
    /** Accounts whose unread notice is rewritten instead. */
    told: Uuid[];
    mails: { user: UserRecord; rendered: RenderedEmail }[];
    /** Emails this batch spent of the fan-out's cap. */
    emailAttempts: number;
  }

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
    const content = { title: notice.title, body: notice.body };
    const vars = {
      api_name: inertText(oneLine(api.name)),
      api_slug: api.slug,
      version: inertText(oneLine(change.version)),
      headline: inertText(notice.headline),
      summary: inertText(notice.summary),
      changes: notice.lines.map(specChangeEmailLine).join('\n'),
      changes_url: `${config.publicUrl}${link}`,
    };
    // Without a renderer nobody is emailed, and everyone is still told in-app.
    let prepared: Renderer | null = null;
    try {
      prepared = await email.prepareRenderer('spec_updated');
    } catch (error) {
      deps.log?.(
        { api_id: api.id, error: error instanceof Error ? error.message : String(error) },
        'Could not prepare the spec change email; grantees are told in-app only',
      );
    }
    const render = prepared;
    const window = Math.floor(now() / SPEC_CHANGE_EMAIL_WINDOW_MS);
    const batches = Math.ceil(recipients.length / SPEC_CHANGE_NOTICE_BATCH);
    // `0` means no ceiling, as it does for a mass email.
    let emailsLeft =
      config.maxMassEmailRecipients > 0 ? config.maxMassEmailRecipients : Number.POSITIVE_INFINITY;
    let failedBatches = 0;

    for (let batch = 0; batch < batches; batch += 1) {
      const ids = recipients.slice(
        batch * SPEC_CHANGE_NOTICE_BATCH,
        (batch + 1) * SPEC_CHANGE_NOTICE_BATCH,
      );
      try {
        const sent = await sendBatch(ids, emailsLeft);
        emailsLeft -= sent.emailAttempts;
        if (sent.counts === null) continue;
        await store.transaction(async (tx) => {
          const counts = sent.counts!;
          counts.emailed = 0;
          for (const { user, rendered } of sent.mails) {
            // At most once per API, recipient and clock hour: a later revision
            // in the same hour finds the row and queues nothing.
            const queued = await tx.emailOutbox.enqueue({
              to_email: user.email,
              subject: rendered.subject,
              body_html: rendered.html,
              body_text: rendered.text,
              idempotency_key: `spec-updated:${api.id}:${user.id}:${window}`,
            });
            if (queued.created) counts.emailed += 1;
          }
          counts.email_coalesced = sent.mails.length - counts.emailed;
          if (sent.inApp.length > 0) {
            await tx.notifications.createMany(
              sent.inApp.map((userId) => ({
                user_id: userId,
                type: 'api_spec_updated' as const,
                title: notice.title,
                body: notice.body,
                link,
              })),
            );
          }
          // A coalesced notice says what the newest revision changed.
          await tx.notifications.updateUnread(sent.told, 'api_spec_updated', link, content);
          await audit.forStore(tx).record(
            actor,
            AuditAction.API_SPEC_NOTIFY,
            { type: 'api', id: api.id },
            {
              spec_id: change.revision_id,
              kind: change.kind,
              version: oneLine(change.version),
              batch: batch + 1,
              batches,
              failed_batches: failedBatches,
              ...counts,
            },
            ip,
          );
        });
      } catch (error) {
        failedBatches += 1;
        deps.log?.(
          {
            api_id: api.id,
            spec_id: change.revision_id,
            batch: batch + 1,
            error: error instanceof Error ? error.message : String(error),
          },
          'A batch of spec change notices failed; the next batch is still tried',
        );
      }
    }

    if (failedBatches > 0) {
      // The failed batches recorded nothing of their own, so one row says so.
      await store.transaction(async (tx) => {
        await audit.forStore(tx).record(
          actor,
          AuditAction.API_SPEC_NOTIFY,
          { type: 'api', id: api.id },
          {
            spec_id: change.revision_id,
            kind: change.kind,
            version: oneLine(change.version),
            batches,
            failed_batches: failedBatches,
          },
          ip,
        );
      });
    }

    /**
     * Everything one batch will write, read and rendered outside its
     * transaction. Grants and account status are read again here, at batch
     * time, so an account revoked or disabled since the fan-out began is not
     * told.
     */
    async function sendBatch(ids: readonly Uuid[], emailBudget: number): Promise<BatchPlan> {
      const found = await store.users.findManyByIds([...ids]);
      const users: UserRecord[] = [];
      for (const user of found) {
        if (user.status !== 'active') continue;
        const active = await store.grants.count({
          api_id: api.id,
          user_id: user.id,
          status: 'active',
        });
        if (active > 0) users.push(user);
      }
      if (users.length === 0) {
        return { counts: null, inApp: [], told: [], mails: [], emailAttempts: 0 };
      }
      const rows = await store.notificationPreferences.findManyByUsers(users.map((u) => u.id));
      const preferences = new Map(rows.map((row) => [row.user_id, row]));
      const wantsInApp = users.filter(
        (user) => preferences.get(user.id)?.api_spec_updated_in_app !== false,
      );
      // Opt-in: only an account that turned email on gets one.
      const wantsEmail = users.filter(
        (user) => preferences.get(user.id)?.api_spec_updated_email === true,
      );
      const told = await store.notifications.listUsersWithUnread(
        wantsInApp.map((user) => user.id),
        'api_spec_updated',
        link,
      );
      const alreadyTold = new Set(told);
      const inApp = wantsInApp.map((user) => user.id).filter((id) => !alreadyTold.has(id));

      const allowed = wantsEmail.slice(0, Math.max(0, emailBudget));
      // Rendered one at a time, before the transaction: the renderer is pure,
      // so a body re-run on contention writes the same rows, and one message
      // it refuses costs that recipient their email and nobody anything else.
      const mails: { user: UserRecord; rendered: RenderedEmail }[] = [];
      let failed = 0;
      for (const user of allowed) {
        if (render === null) {
          failed += 1;
          continue;
        }
        try {
          const rendered = render({
            ...vars,
            recipient_name: inertText(oneLine(user.display_name)),
            recipient_email: user.email,
          });
          mails.push({ user, rendered });
        } catch {
          failed += 1;
        }
      }
      return {
        counts: {
          recipients: users.length,
          notified: inApp.length,
          already_notified: alreadyTold.size,
          in_app_off: users.length - wantsInApp.length,
          emailed: 0,
          email_coalesced: 0,
          email_off: users.length - wantsEmail.length,
          email_capped: wantsEmail.length - allowed.length,
          email_failed: failed,
        },
        inApp,
        told,
        mails,
        emailAttempts: allowed.length,
      };
    }
  }

  const inFlight = new Set<Promise<void>>();

  return {
    notify(actor, api, change, ip): Promise<void> {
      const run = fanOut(actor, api, change, ip).catch((error: unknown) => {
        deps.log?.(
          {
            api_id: api.id,
            spec_id: change.revision_id,
            error: error instanceof Error ? error.message : String(error),
          },
          'Could not notify grantees of a spec change; the revision itself is published',
        );
      });
      inFlight.add(run);
      void run.finally(() => inFlight.delete(run));
      return run;
    },

    async idle(): Promise<void> {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
  };
}
