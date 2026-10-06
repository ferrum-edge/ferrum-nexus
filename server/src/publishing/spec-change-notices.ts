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
 * the next. Fan-outs of one API run one at a time, and of several waiting only
 * the newest runs, carrying whether any it replaced broke something. On a
 * graceful stop no further batch starts and the wait is bounded; a crash loses
 * what is left. Nothing retries it. The notices and emails of one batch commit
 * together with the `api.spec_notify` audit row that counts them, so a batch
 * is never half recorded. Each body is plain text built from the stored change summary, with
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
  /**
   * `<API name> spec updated to 2.0.0`, the in-app title, ending in
   * {@link BREAKING_TITLE_MARK} when the revision includes a breaking change.
   */
  title: string;
  /** Whether the revision includes a breaking change. */
  breaking: boolean;
  /** Counts in a sentence or two, plus the caveats. */
  summary: string;
  /** The named changes, removed operations first, then `and N more`. */
  lines: string[];
  /** The in-app body: the summary and the named changes. */
  body: string;
}

/**
 * How a notice's title says its revision included a breaking change. A notice
 * rewritten by a later revision keeps it, so a breaking change is never
 * dropped from an unread notice by a harmless one after it.
 */
export const BREAKING_TITLE_MARK = ' (breaking changes)';

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

/** `a, b and N more`, naming at most {@link SPEC_CHANGE_NOTICE_NAMED}. */
function namedList(items: readonly string[]): string {
  const shown = items.slice(0, SPEC_CHANGE_NOTICE_NAMED);
  const rest = items.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
}

/**
 * How a grantee gets back tools an explicit approval stopped covering: a
 * request for them on the grant it already holds, which keeps its REST access
 * and its other tools while the provider decides.
 */
function toolRecoveryText(count: number): string {
  const them = count === 1 ? 'it' : 'them';
  return (
    `To use ${them} again, request ${them} on your existing grant from the API's catalog ` +
    'page: your current access stays in place while the provider reviews the request.'
  );
}

/**
 * What a grantee is told about agent tools whose definition changed: an
 * explicit tool approval is per definition, so a changed tool leaves it until
 * the holder requests it on the grant and the provider approves.
 */
export function agentToolsChangedText(tools: readonly string[]): string {
  // A tool name is provider-written, but limited to `A-Za-z0-9_.-`.
  const list = namedList(tools.map(oneLine));
  const them = tools.length === 1 ? 'it' : 'them';
  return (
    `The definition of ${plural(tools.length, 'agent tool')} changed (${list}). An explicit ` +
    `tool approval no longer covers ${them}. ${toolRecoveryText(tools.length)}`
  );
}

/**
 * What a grantee is told about agent tools the provider renamed, as
 * `[old name, new name]` pairs. An explicit approval names one published tool,
 * so a renamed tool leaves it, while an all-tools grant keeps it under its new
 * name; without this notice the holder would only see it vanish.
 */
export function agentToolsRenamedText(renames: readonly (readonly [string, string])[]): string {
  const list = namedList(renames.map(([from, to]) => `${oneLine(from)} to ${oneLine(to)}`));
  const them = renames.length === 1 ? 'it' : 'them';
  return (
    `The provider renamed ${plural(renames.length, 'agent tool')} (${list}). An explicit ` +
    `tool approval no longer covers ${them} under the new name. ` +
    toolRecoveryText(renames.length)
  );
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
  const tools = report.agent_tools_changed ?? [];

  const sentences: string[] = [];
  if (total === 0) {
    // Nothing structural: `changed` is set by an `info` field or an agent
    // tool's definition alone.
    const fields = report.info_changes;
    const named =
      fields.length > 1 ? `${fields.slice(0, -1).join(', ')} and ${fields.at(-1)}` : fields[0];
    if (named !== undefined) {
      sentences.push(tools.length > 0 ? `Its ${named} changed.` : `Only its ${named} changed.`);
    } else if (tools.length === 0) {
      sentences.push('The comparison found no difference in its operations or schemas.');
    }
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
  if (tools.length > 0) sentences.push(agentToolsChangedText(tools));
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
  const breaking = counts.breaking > 0;
  const title = `${oneLine(apiName)} spec ${headline}${breaking ? BREAKING_TITLE_MARK : ''}`;
  return { headline, title, breaking, summary, lines, body };
}

/** A line as the email carries it: a list item, inert as a link. */
export function specChangeEmailLine(line: string): string {
  return `- ${inertText(line)}`;
}

/**
 * What an unread notice becomes when a later revision rewrites it: the newest
 * summary, saying that earlier revisions are on the Changes tab, and still
 * marked breaking when an earlier one was.
 */
export function rewrittenNotice(
  notice: SpecChangeNotice,
  earlierBreaking: boolean,
): { title: string; body: string } {
  const title =
    earlierBreaking && !notice.breaking ? `${notice.title}${BREAKING_TITLE_MARK}` : notice.title;
  const earlier =
    earlierBreaking && !notice.breaking
      ? 'An earlier revision since you last read included breaking changes; see the Changes tab.'
      : 'Earlier revisions since you last read are on the Changes tab too.';
  return { title, body: `${notice.body} ${earlier}` };
}

/** Tells an API's grantees about a recorded spec change. */
export interface SpecChangeNotifier {
  /**
   * Notify the grantees of `api` of `change`, published by `actor`. The
   * returned promise never rejects — the revision is already published, and a
   * failure is logged — so a caller may leave it to run.
   *
   * Fan-outs of one API run one at a time. One asked for while another is
   * running waits, and if several wait, only the newest runs: its notice and
   * the Changes tab it links to cover the ones it replaced.
   */
  notify(
    actor: { id: Uuid; role: Role },
    api: ApiRecord,
    change: ApiSpecChangeEntry,
    ip: string | null,
  ): Promise<void>;
  /** Settles once every fan-out asked for so far has finished. */
  idle(): Promise<void>;
  /**
   * Stop starting batches, and wait at most `limitMs` for the ones running.
   * What is left is not sent: the fan-out is best-effort.
   */
  stop(limitMs?: number): Promise<void>;
}

/** How long a graceful stop waits for fan-outs still running. */
export const SPEC_CHANGE_STOP_LIMIT_MS = 10_000;

/** Dependencies of {@link createSpecChangeNotifier}. */
export interface SpecChangeNotifierDeps {
  store: NexusStore;
  email: Pick<EmailService, 'prepareRenderer'>;
  audit: AuditService;
  config: Pick<NexusConfig, 'publicUrl' | 'maxMassEmailRecipients'>;
  log?: (obj: Record<string, unknown>, message: string) => void;
  /** Clock for the email window; tests move it. */
  now?: () => number;
  /**
   * Called with each batch's accounts once it is planned and before it is
   * written. A test seam, for changing the store between a batch's reads and
   * its transaction, or between batches.
   */
  onBatch?: (batch: number, ids: readonly Uuid[]) => Promise<void> | void;
}

/** A prepared `spec_updated` renderer. */
type Renderer = Awaited<ReturnType<EmailService['prepareRenderer']>>;

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
  /** Accounts that want the in-app notice: a new one, or their unread one rewritten. */
  inApp: Uuid[];
  mails: { user: UserRecord; rendered: RenderedEmail }[];
  /** Emails this batch spent of the fan-out's cap. */
  emailAttempts: number;
}

/** One fan-out asked for. */
interface FanOut {
  actor: { id: Uuid; role: Role };
  api: ApiRecord;
  change: ApiSpecChangeEntry;
  ip: string | null;
  /** Revisions of the same API whose waiting fan-outs this one replaced, oldest first. */
  supersededIds: Uuid[];
  /** Whether any of those revisions included a breaking change. */
  supersededBreaking: boolean;
}

/** What a waiting fan-out passes on to the one that replaces it. */
function carriedFrom(
  previous: FanOut | null,
): Pick<FanOut, 'supersededIds' | 'supersededBreaking'> {
  if (previous === null) return { supersededIds: [], supersededBreaking: false };
  return {
    supersededIds: [...previous.supersededIds, previous.change.revision_id],
    supersededBreaking: previous.supersededBreaking || previous.change.report.counts.breaking > 0,
  };
}

/** What an email adds when a replaced revision broke something and this one did not. */
const SUPERSEDED_BREAKING_NOTE =
  'A revision published just before this one included breaking changes; see the Changes tab.';

/** Build the spec-change notifier. */
export function createSpecChangeNotifier(deps: SpecChangeNotifierDeps): SpecChangeNotifier {
  const { store, email, audit, config } = deps;
  const now = deps.now ?? Date.now;
  let stopping = false;

  /** Log, and never let logging itself throw out of a fan-out. */
  const log = (obj: Record<string, unknown>, message: string): void => {
    try {
      deps.log?.(obj, message);
    } catch {
      // Nothing left to tell.
    }
  };

  async function fanOut(run: FanOut): Promise<void> {
    const { actor, api, change, ip } = run;
    // One notice per account, however many of its identities hold a grant,
    // and none for the account that published the change. Accounts past the
    // email cap are the ones latest in this list.
    const grants = await store.grants.listActiveByApi(api.id);
    const holders = new Set(grants.map((grant) => grant.user_id));
    holders.delete(actor.id);
    const recipients = [...holders];
    if (recipients.length === 0) return;

    const type = 'api_spec_updated' as const;
    const link = `/catalog/${encodeURIComponent(api.slug)}?tab=changes`;
    const notice = summarizeSpecChange(api.name, change);
    // A replaced revision that broke something is still news: it marks every
    // notice, fresh or rewritten, and the email says so.
    const carried = run.supersededBreaking && !notice.breaking;
    const freshContent = carried
      ? rewrittenNotice(notice, true)
      : { title: notice.title, body: notice.body };
    const summary = carried ? `${notice.summary} ${SUPERSEDED_BREAKING_NOTE}` : notice.summary;
    const vars = {
      api_name: inertText(oneLine(api.name)),
      api_slug: api.slug,
      version: inertText(oneLine(change.version)),
      headline: inertText(notice.headline),
      summary: inertText(summary),
      changes: notice.lines.map(specChangeEmailLine).join('\n'),
      changes_url: `${config.publicUrl}${link}`,
    };
    // Without a renderer nobody is emailed, and everyone is still told in-app.
    let prepared: Renderer | null = null;
    try {
      prepared = await email.prepareRenderer('spec_updated');
    } catch (error) {
      log(
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
    let skippedBatches = 0;

    const details = (): Record<string, unknown> => ({
      spec_id: change.revision_id,
      kind: change.kind,
      version: oneLine(change.version),
      superseded: run.supersededIds.length,
      superseded_spec_ids: run.supersededIds,
      superseded_breaking: run.supersededBreaking,
      batches,
      failed_batches: failedBatches,
    });

    for (let batch = 0; batch < batches; batch += 1) {
      // A graceful stop sends no further batches.
      if (stopping) {
        skippedBatches = batches - batch;
        break;
      }
      const ids = recipients.slice(
        batch * SPEC_CHANGE_NOTICE_BATCH,
        (batch + 1) * SPEC_CHANGE_NOTICE_BATCH,
      );
      try {
        const plan = await planBatch(ids, emailsLeft);
        emailsLeft -= plan.emailAttempts;
        if (plan.counts === null) continue;
        await deps.onBatch?.(batch + 1, ids);
        await store.transaction(async (tx) => {
          const counts = { ...plan.counts! };
          for (const { user, rendered } of plan.mails) {
            // At most once per API, recipient and clock hour: a later revision
            // in the same hour finds the row and queues nothing.
            const queued = await tx.emailOutbox.enqueue({
              to_email: user.email,
              recipient_user_id: user.id,
              subject: rendered.subject,
              body_html: rendered.html,
              body_text: rendered.text,
              idempotency_key: `spec-updated:${api.id}:${user.id}:${window}`,
            });
            if (queued.created) counts.emailed += 1;
          }
          counts.email_coalesced = plan.mails.length - counts.emailed;
          // Read in the transaction that acts on it, so a notice read since the
          // batch was planned gets a fresh notice rather than nothing.
          const unread = await tx.notifications.listUnread(plan.inApp, type, link);
          const unreadBy = new Map(unread.map((row) => [row.user_id, row]));
          const fresh = plan.inApp.filter((userId) => !unreadBy.has(userId));
          if (fresh.length > 0) {
            await tx.notifications.createMany(
              fresh.map((userId) => ({
                user_id: userId,
                type,
                title: freshContent.title,
                body: freshContent.body,
                link,
              })),
            );
          }
          // A rewritten notice keeps saying an earlier revision was breaking,
          // whichever of an account's unread notices said it.
          const marked = new Set<Uuid>();
          for (const row of unread) {
            if (carried || row.title.endsWith(BREAKING_TITLE_MARK)) marked.add(row.user_id);
          }
          const earlierBreaking = [...unreadBy.keys()].filter((userId) => marked.has(userId));
          const plain = [...unreadBy.keys()].filter((userId) => !marked.has(userId));
          await tx.notifications.updateUnread(
            earlierBreaking,
            type,
            link,
            rewrittenNotice(notice, true),
          );
          await tx.notifications.updateUnread(plain, type, link, rewrittenNotice(notice, false));
          counts.notified = fresh.length;
          counts.already_notified = unreadBy.size;
          await audit
            .forStore(tx)
            .record(
              actor,
              AuditAction.API_SPEC_NOTIFY,
              { type: 'api', id: api.id },
              { ...details(), batch: batch + 1, ...counts },
              ip,
            );
        });
      } catch (error) {
        failedBatches += 1;
        log(
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

    if (failedBatches > 0 || skippedBatches > 0) {
      // Batches that failed or were skipped recorded nothing, so one row says so.
      await store.transaction(async (tx) => {
        await audit
          .forStore(tx)
          .record(
            actor,
            AuditAction.API_SPEC_NOTIFY,
            { type: 'api', id: api.id },
            { ...details(), skipped_batches: skippedBatches },
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
    async function planBatch(ids: readonly Uuid[], emailBudget: number): Promise<BatchPlan> {
      const holding = new Set(await store.grants.listActiveHolders(api.id, [...ids]));
      const found = await store.users.findManyByIds([...ids]);
      const users = found.filter((user) => user.status === 'active' && holding.has(user.id));
      if (users.length === 0) return { counts: null, inApp: [], mails: [], emailAttempts: 0 };
      const rows = await store.notificationPreferences.findManyByUsers(users.map((u) => u.id));
      const preferences = new Map(rows.map((row) => [row.user_id, row]));
      const wantsInApp = users.filter(
        (user) => preferences.get(user.id)?.api_spec_updated_in_app !== false,
      );
      // Opt-in: only an account that turned email on gets one.
      const wantsEmail = users.filter(
        (user) => preferences.get(user.id)?.api_spec_updated_email === true,
      );

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
          notified: 0,
          already_notified: 0,
          in_app_off: users.length - wantsInApp.length,
          emailed: 0,
          email_coalesced: 0,
          email_off: users.length - wantsEmail.length,
          email_capped: wantsEmail.length - allowed.length,
          email_failed: failed,
        },
        inApp: wantsInApp.map((user) => user.id),
        mails,
        emailAttempts: allowed.length,
      };
    }
  }

  /** Each API's running fan-out, and the newest one waiting behind it. */
  const lanes = new Map<Uuid, { waiting: FanOut | null; done: Promise<void> }>();

  const runSafely = async (run: FanOut): Promise<void> => {
    try {
      await fanOut(run);
    } catch (error) {
      log(
        {
          api_id: run.api.id,
          spec_id: run.change.revision_id,
          error: error instanceof Error ? error.message : String(error),
        },
        'Could not notify grantees of a spec change; the revision itself is published',
      );
    }
  };

  /** A waiting fan-out a graceful stop will not run: logged, and recorded if it can be. */
  const recordDiscarded = async (run: FanOut): Promise<void> => {
    const specIds = [...run.supersededIds, run.change.revision_id];
    log(
      { api_id: run.api.id, spec_ids: specIds },
      'Stopping: a waiting spec change fan-out was not sent',
    );
    try {
      await store.transaction(async (tx) => {
        await audit.forStore(tx).record(
          run.actor,
          AuditAction.API_SPEC_NOTIFY,
          { type: 'api', id: run.api.id },
          {
            spec_id: run.change.revision_id,
            kind: run.change.kind,
            discarded: true,
            superseded_spec_ids: run.supersededIds,
          },
          run.ip,
        );
      });
    } catch (error) {
      log(
        { api_id: run.api.id, error: error instanceof Error ? error.message : String(error) },
        'Could not record a discarded spec change fan-out',
      );
    }
  };

  const idle = async (): Promise<void> => {
    while (lanes.size > 0) await Promise.all([...lanes.values()].map((lane) => lane.done));
  };

  return {
    notify(actor, api, change, ip): Promise<void> {
      // A revision that changed nothing is nobody's news, and must not take
      // the place of one waiting that did.
      if (!change.report.changed || stopping) return Promise.resolve();
      const lane = lanes.get(api.id);
      if (lane) {
        lane.waiting = { actor, api, change, ip, ...carriedFrom(lane.waiting) };
        return lane.done;
      }
      const created: { waiting: FanOut | null; done: Promise<void> } = {
        waiting: null,
        done: Promise.resolve(),
      };
      lanes.set(api.id, created);
      created.done = (async (): Promise<void> => {
        let next: FanOut | null = { actor, api, change, ip, ...carriedFrom(null) };
        while (next !== null) {
          await runSafely(next);
          const waiting: FanOut | null = created.waiting;
          created.waiting = null;
          if (waiting !== null && stopping) {
            await recordDiscarded(waiting);
            next = null;
          } else {
            next = waiting;
          }
        }
        lanes.delete(api.id);
      })();
      return created.done;
    },

    idle,

    async stop(limitMs = SPEC_CHANGE_STOP_LIMIT_MS): Promise<void> {
      stopping = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const limit = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, limitMs);
      });
      try {
        await Promise.race([idle(), limit]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
