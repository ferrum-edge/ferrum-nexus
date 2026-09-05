/**
 * Portal messaging: 1:1 threads plus a platform inbox.
 *
 * ## Design decision — what a thread is
 *
 * A thread has exactly two seats, `participant_a` and `participant_b`:
 *
 * - **1:1 thread** — a client and a provider, optionally about one API.
 *   `participant_a` holds the lower-privileged party (the client in the normal
 *   case) so the entity contract's "a is the client, b is the provider" reads
 *   true whichever side opened the conversation.
 * - **Platform thread** — `participant_b` is `null`. The remaining seat is the
 *   user; the empty seat is "the platform", and **any admin may read and
 *   reply**. This is how a client reaches support without being coupled to one
 *   named administrator, and how a god-mode broadcast lands in an inbox rather
 *   than only in the notification bell.
 *
 * Threads are deduplicated on `(participants, api_id)`: asking the same
 * provider about the same API twice continues the existing conversation instead
 * of fragmenting it.
 *
 * Every posted message writes an audit row, notifies the counterparty in-app,
 * and enqueues a `message_received` email. Notification/email failures are
 * never allowed to fail the send — the message is already durable by then.
 *
 * ## Abuse controls
 *
 * A message is cheap to send and permanently expensive to hold: one row here,
 * one audit row, and — for a platform thread — a notification row and a queued
 * email **per active administrator**. Three bounds keep an authenticated
 * account from turning that fan-out into a mail bomb or an unbounded write:
 *
 * 1. **Per-minute limiters** on the routes (composed in `index.ts`), keyed per
 *    account rather than per IP.
 * 2. **A rolling 24-hour budget** enforced here, *before any row is written*,
 *    so a refusal leaves no message, audit, notification or outbox row behind.
 *    Direct and platform threads draw on one budget by construction: it counts
 *    the sender, not the thread.
 * 3. **Email coalescing** — at most one `message_received` mail per recipient
 *    per thread per {@link COALESCE_WINDOW_MS}, via the outbox's idempotency
 *    key. In-app notifications stay one per message; they are cheap, and the
 *    first two bounds already cap how many there can be.
 */

import {
  clampPageSize,
  roleAtLeast,
  type ApiSummary,
  type Message,
  type MessagePage,
  type MessageThread,
  type MessageThreadDetail,
  type Paginated,
  type UserSummary,
  type Uuid,
} from '@ferrum-nexus/shared';

import { AuditAction, type AuditService } from '../audit/service.js';
import type { NexusConfig } from '../config/index.js';
import type {
  ListOptions,
  MessageCursor,
  MessageRecord,
  NexusStore,
  ThreadRecord,
  UserRecord,
} from '../db/store.js';
import type { EmailService } from '../email/service.js';
import { NexusError, forbidden, notFound, validationFailed } from '../lib/errors.js';
import { nowIso } from '../lib/ids.js';
import type { NotificationsService } from '../notifications/service.js';
import { presentApiSummary, type GatewayUrlSource } from '../publishing/present.js';

/** Characters of the newest message shown in list previews and emails. */
export const MESSAGE_PREVIEW_LENGTH = 160;

/** Width of the rolling per-account message budget, in milliseconds. */
export const MESSAGE_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Human label for {@link MESSAGE_BUDGET_WINDOW_MS}, echoed in the error details. */
export const MESSAGE_BUDGET_WINDOW_LABEL = '24h';

/**
 * How long one `message_received` email covers.
 *
 * A recipient gets at most one mail per thread per window however many messages
 * land in it, so a reply storm costs one notification row each and one email.
 * Ten minutes is short enough that a real conversation still pages someone
 * promptly and long enough that a flood collapses to a single message.
 */
export const COALESCE_WINDOW_MS = 10 * 60 * 1000;

/** Input for {@link MessagingService.createThread}. */
export interface CreateThreadInput {
  actor: UserRecord;
  subject: string;
  /** Body of the opening message. */
  body: string;
  /** The counterparty; omit (or `null`) to address the platform admins. */
  recipientUserId?: Uuid | null;
  /** Optional API the conversation is about. */
  apiId?: Uuid | null;
  ip?: string | null;
}

/** Filters accepted by {@link MessagingService.listThreadsFor}. */
export interface ThreadListFilter {
  api_id?: Uuid;
  q?: string;
}

/** Which window of a conversation to read. */
export interface MessagePageOptions {
  /** Window size; clamped to `[1, MAX_PAGE_SIZE]`. */
  limit?: number;
  /** Id of a message to read strictly backwards from. Must be in the thread. */
  before?: Uuid;
}

/** Messaging operations. */
export interface MessagingService {
  /** Open (or continue) a conversation and post its first message. */
  createThread(
    input: CreateThreadInput,
  ): Promise<{ thread: MessageThread; message: Message; created: boolean }>;
  /** Threads the user may see, newest activity first. */
  listThreadsFor(
    user: UserRecord,
    filter?: ThreadListFilter,
    options?: ListOptions,
  ): Promise<Paginated<MessageThread>>;
  /** One thread with its most recent window of messages. */
  getThread(
    user: UserRecord,
    threadId: Uuid,
    options?: MessagePageOptions,
  ): Promise<MessageThreadDetail>;
  /** One window of a thread's transcript, for walking back through history. */
  listMessages(
    user: UserRecord,
    threadId: Uuid,
    options?: MessagePageOptions,
  ): Promise<MessagePage>;
  /** Post a message into an existing thread. */
  sendMessage(user: UserRecord, threadId: Uuid, body: string, ip?: string | null): Promise<Message>;
}

/** Dependencies of {@link createMessagingService}. */
export interface MessagingServiceDeps {
  config: NexusConfig;
  store: NexusStore;
  notifications: NotificationsService;
  email: EmailService;
  audit: AuditService;
  /** Resolves the gateway origin a thread's embedded API summary carries. */
  settings: GatewayUrlSource;
  log?: (obj: Record<string, unknown>, message: string) => void;
}

/** Reduce a stored user to the summary embedded in message payloads. */
export function toUserSummary(record: UserRecord): UserSummary {
  return {
    id: record.id,
    email: record.email,
    display_name: record.display_name,
    role: record.role,
  };
}

/**
 * True when `user` occupies one of the thread's two seats.
 *
 * **`created_by` is not a seat.** It records who opened the conversation and is
 * never rewritten, so counting it as membership makes access permanent: a
 * god-mode broadcast seats only the recipient, and treating its sender as a
 * participant left them able to read and post in every recipient's platform
 * thread for good — including after being demoted out of admin entirely.
 * Oversight comes from the caller's *current* role in the read and post
 * guards, which a demotion actually takes away. Every 1:1 thread seats its
 * creator (see `createThread`), so the honest cases are unaffected.
 */
export function isThreadParticipant(user: UserRecord, thread: ThreadRecord): boolean {
  return thread.participant_a === user.id || thread.participant_b === user.id;
}

/** A thread with an empty second seat is the platform inbox. */
export function isPlatformThread(thread: ThreadRecord): boolean {
  return thread.participant_b === null;
}

/** Build the messaging service. */
export function createMessagingService(deps: MessagingServiceDeps): MessagingService {
  const { config, store, notifications, email, audit, settings } = deps;

  function threadUrl(threadId: Uuid): string {
    return `${config.publicUrl}/messages/${threadId}`;
  }

  function preview(body: string): string {
    const flat = body.replace(/\s+/g, ' ').trim();
    return flat.length <= MESSAGE_PREVIEW_LENGTH
      ? flat
      : `${flat.slice(0, MESSAGE_PREVIEW_LENGTH - 1)}…`;
  }

  /** Attach api/participant/preview joins to a page of threads. */
  async function decorate(threads: ThreadRecord[]): Promise<MessageThread[]> {
    if (threads.length === 0) return [];
    const userIds = new Set<Uuid>();
    const apiIds = new Set<Uuid>();
    for (const thread of threads) {
      userIds.add(thread.participant_a);
      if (thread.participant_b) userIds.add(thread.participant_b);
      userIds.add(thread.created_by);
      if (thread.api_id) apiIds.add(thread.api_id);
    }
    const users = new Map(
      (await store.users.findManyByIds([...userIds])).map((user) => [user.id, user]),
    );
    const apis = new Map(
      (apiIds.size > 0 ? await store.apis.findManyByIds([...apiIds]) : []).map((api) => [
        api.id,
        api,
      ]),
    );

    const gatewayUrl = await settings.getGatewayPublicUrl();

    return Promise.all(
      threads.map(async (thread) => {
        const participants: UserSummary[] = [];
        for (const id of [thread.participant_a, thread.participant_b]) {
          const record = id ? users.get(id) : undefined;
          if (record) participants.push(toUserSummary(record));
        }
        const api = thread.api_id ? apis.get(thread.api_id) : undefined;
        const apiSummary: ApiSummary | undefined = api
          ? presentApiSummary(api, gatewayUrl)
          : undefined;
        const latest = await store.messages.findLatestByThread(thread.id);
        return {
          ...thread,
          ...(apiSummary ? { api: apiSummary } : {}),
          participants,
          last_message_preview: latest ? preview(latest.body) : null,
        };
      }),
    );
  }

  /** Who should hear about a new message in `thread`, other than the sender. */
  async function recipientsFor(thread: ThreadRecord, senderId: Uuid): Promise<UserRecord[]> {
    if (!isPlatformThread(thread)) {
      const otherId =
        thread.participant_a === senderId ? thread.participant_b : thread.participant_a;
      if (!otherId || otherId === senderId) return [];
      const other = await store.users.findById(otherId);
      return other && other.status === 'active' ? [other] : [];
    }
    // Platform thread: the user's side is one seat, every admin is the other.
    if (thread.participant_a !== senderId) {
      const owner = await store.users.findById(thread.participant_a);
      return owner && owner.status === 'active' ? [owner] : [];
    }
    const admins = await store.users.listRecipients({
      roles: ['admin', 'super_admin'],
      status: 'active',
    });
    return admins.filter((admin) => admin.id !== senderId);
  }

  /** Fan out the in-app notification and the queued email for one message. */
  async function announce(
    thread: ThreadRecord,
    sender: UserRecord,
    message: MessageRecord,
  ): Promise<void> {
    const recipients = await recipientsFor(thread, sender.id);
    const body = preview(message.body);
    // One bucket per {@link COALESCE_WINDOW_MS}; the outbox's unique
    // `idempotency_key` turns every later message in the same bucket into a
    // no-op enqueue, so N messages cost one mail per recipient per thread.
    const bucket = Math.floor(Date.now() / COALESCE_WINDOW_MS);
    for (const recipient of recipients) {
      try {
        await notifications.notify(
          recipient.id,
          'message_received',
          `New message from ${sender.display_name}`,
          body,
          `/messages/${thread.id}`,
        );
        await email.enqueue({
          to: recipient.email,
          templateKey: 'message_received',
          idempotencyKey: `message_received:${thread.id}:${recipient.id}:${bucket}`,
          vars: {
            recipient_name: recipient.display_name,
            recipient_email: recipient.email,
            sender_name: sender.display_name,
            thread_subject: thread.subject,
            message_preview: body,
            thread_url: threadUrl(thread.id),
          },
        });
      } catch (error) {
        // The message is already stored; a notification problem must not undo it.
        deps.log?.(
          {
            thread_id: thread.id,
            recipient_id: recipient.id,
            error: error instanceof Error ? error.message : String(error),
          },
          'Could not announce a new message',
        );
      }
    }
  }

  /**
   * Refuse the send when the sender has spent their rolling 24-hour budget.
   *
   * Called inside the same serialised database transaction as the message
   * insert, so concurrent sends cannot all spend the same remaining slot.
   * `0` means the operator turned the budget off.
   */
  async function assertWithinBudget(tx: NexusStore, senderUserId: Uuid): Promise<void> {
    const limit = config.maxMessagesPerUserPerDay;
    if (limit <= 0) return;
    const since = new Date(Date.now() - MESSAGE_BUDGET_WINDOW_MS).toISOString();
    const used = await tx.messages.countBySenderSince(senderUserId, since);
    if (used < limit) return;
    throw new NexusError(
      'QUOTA_EXCEEDED',
      `You have reached the limit of ${limit} messages per ${MESSAGE_BUDGET_WINDOW_LABEL}. ` +
        'Wait for the oldest of them to age out, or ask an administrator to raise the limit.',
      {
        limit,
        window: MESSAGE_BUDGET_WINDOW_LABEL,
        setting: 'NEXUS_MAX_MESSAGES_PER_USER_PER_DAY',
      },
    );
  }

  async function loadThread(threadId: Uuid): Promise<ThreadRecord> {
    const thread = await store.threads.findById(threadId);
    if (!thread) throw notFound('Thread', threadId);
    return thread;
  }

  /**
   * One window of a thread's transcript, newest-first from the database and
   * reversed into reading order.
   *
   * The window is always anchored at the *end* of the conversation, optionally
   * walked backwards with `before`. A fixed oldest-first page could not reach
   * the end at all: once a thread held more than a page of messages, every new
   * reply landed outside it and the sender watched their own message vanish.
   */
  async function messagePage(
    thread: ThreadRecord,
    options: MessagePageOptions | undefined,
  ): Promise<MessagePage> {
    const limit = clampPageSize(options?.limit);
    const before = options?.before ? await resolveCursor(thread.id, options.before) : undefined;

    const window = await store.messages.listByThread(thread.id, {
      limit,
      newest_first: true,
      ...(before ? { before } : {}),
    });
    // `total` on that read counts what precedes the window's newest end, which
    // is exactly the "is there more history?" question.
    const hasMore = window.total > window.items.length;
    const ordered = [...window.items].reverse();

    const senders = new Map(
      (
        await store.users.findManyByIds([
          ...new Set(ordered.map((message) => message.sender_user_id)),
        ])
      ).map((record) => [record.id, record]),
    );
    const items: Message[] = ordered.map((message) => {
      const sender = senders.get(message.sender_user_id);
      return sender ? { ...message, sender: toUserSummary(sender) } : { ...message };
    });

    return {
      items,
      total: await store.messages.countByThread(thread.id),
      has_more: hasMore,
      next_before: hasMore ? (items[0]?.id ?? null) : null,
    };
  }

  /**
   * Turn a caller-supplied message id into the `(created_at, id)` point the
   * store pages from, refusing an id that belongs to another conversation —
   * otherwise a cursor would leak the timestamps of messages the caller cannot
   * read.
   */
  async function resolveCursor(threadId: Uuid, messageId: Uuid): Promise<MessageCursor> {
    const anchor = await store.messages.findById(messageId);
    if (!anchor || anchor.thread_id !== threadId) {
      throw validationFailed('That message is not part of this conversation', {
        before: messageId,
      });
    }
    return { created_at: anchor.created_at, id: anchor.id };
  }

  /**
   * Read access: the two seats, plus the caller's *current* admin role for
   * oversight and support. Nothing here is derived from who created the
   * thread — see {@link isThreadParticipant}.
   */
  function assertCanRead(user: UserRecord, thread: ThreadRecord): void {
    if (isThreadParticipant(user, thread)) return;
    if (roleAtLeast(user.role, 'admin')) return;
    throw forbidden('You are not a participant in this conversation');
  }

  /** Write access: the two seats, plus any current admin answering the platform inbox. */
  function assertCanPost(user: UserRecord, thread: ThreadRecord): void {
    if (isThreadParticipant(user, thread)) return;
    if (isPlatformThread(thread) && roleAtLeast(user.role, 'admin')) return;
    throw forbidden('You are not a participant in this conversation');
  }

  return {
    async createThread(input) {
      const subject = input.subject.trim();
      const body = input.body.trim();
      if (subject === '') throw validationFailed('A subject is required');
      if (body === '') throw validationFailed('A message body is required');
      let counterpart: UserRecord | null = null;
      if (input.recipientUserId) {
        if (input.recipientUserId === input.actor.id) {
          throw validationFailed('You cannot open a conversation with yourself');
        }
        counterpart = await store.users.findById(input.recipientUserId);
        if (!counterpart || counterpart.status !== 'active') {
          throw notFound('Recipient', input.recipientUserId);
        }
      }

      let apiId: Uuid | null = null;
      if (input.apiId) {
        const api = await store.apis.findById(input.apiId);
        if (!api) throw notFound('API', input.apiId);
        apiId = api.id;
      }

      // Seat assignment: the lower-privileged party takes `participant_a`, so a
      // provider-initiated thread has the same shape as a client-initiated one.
      let participantA = input.actor.id;
      let participantB: Uuid | null = counterpart?.id ?? null;
      if (counterpart && roleAtLeast(counterpart.role, input.actor.role) === false) {
        participantA = counterpart.id;
        participantB = input.actor.id;
      }

      const { existing, thread, message, at } = await store.transaction(async (tx) => {
        await assertWithinBudget(tx, input.actor.id);
        const existing = await tx.threads.findExisting(participantA, participantB, apiId);
        const thread =
          existing ??
          (await tx.threads.create({
            subject,
            api_id: apiId,
            created_by: input.actor.id,
            participant_a: participantA,
            participant_b: participantB,
          }));
        const message = await tx.messages.create({
          thread_id: thread.id,
          sender_user_id: input.actor.id,
          body,
        });
        const at = nowIso();
        await tx.threads.touchLastMessage(thread.id, at);
        return { existing, thread, message, at };
      });

      if (!existing) {
        await audit.record(
          { id: input.actor.id, role: input.actor.role },
          AuditAction.MESSAGE_THREAD_CREATE,
          { type: 'message_thread', id: thread.id },
          { subject, api_id: apiId, platform: participantB === null },
          input.ip ?? null,
        );
      }
      await audit.record(
        { id: input.actor.id, role: input.actor.role },
        AuditAction.MESSAGE_SEND,
        { type: 'message', id: message.id },
        { thread_id: thread.id },
        input.ip ?? null,
      );

      await announce(thread, input.actor, message);

      const [decorated] = await decorate([{ ...thread, last_message_at: at }]);
      return {
        thread: decorated ?? { ...thread, last_message_at: at },
        message: { ...message, sender: toUserSummary(input.actor) },
        created: existing === null,
      };
    },

    async listThreadsFor(user, filter = {}, options): Promise<Paginated<MessageThread>> {
      const base = {
        ...(filter.api_id !== undefined ? { api_id: filter.api_id } : {}),
        ...(filter.q !== undefined ? { q: filter.q } : {}),
      };

      // Both audiences are one query with a different seat predicate: an
      // ordinary user sees the threads they sit in, an admin additionally sees
      // the platform inbox (`participant_b IS NULL`). The admin half used to
      // scan one bounded page and select in memory, which put every platform
      // thread behind a page of unrelated conversations out of reach whatever
      // offset the caller asked for, and reported the survivors as `total`.
      const seats = roleAtLeast(user.role, 'admin')
        ? { platform_or_participant_user_id: user.id }
        : { participant_user_id: user.id };
      const page = await store.threads.list({ ...base, ...seats }, options);
      return { items: await decorate(page.items), total: page.total };
    },

    async getThread(user, threadId, options): Promise<MessageThreadDetail> {
      const thread = await loadThread(threadId);
      assertCanRead(user, thread);
      const [decorated, messages] = await Promise.all([
        decorate([thread]).then(([entry]) => entry),
        messagePage(thread, options),
      ]);
      return { ...(decorated ?? thread), messages };
    },

    async listMessages(user, threadId, options): Promise<MessagePage> {
      const thread = await loadThread(threadId);
      assertCanRead(user, thread);
      return messagePage(thread, options);
    },

    async sendMessage(user, threadId, body, ip = null): Promise<Message> {
      const trimmed = body.trim();
      if (trimmed === '') throw validationFailed('A message body is required');
      const thread = await loadThread(threadId);
      assertCanPost(user, thread);

      const message = await store.transaction(async (tx) => {
        await assertWithinBudget(tx, user.id);
        const created = await tx.messages.create({
          thread_id: thread.id,
          sender_user_id: user.id,
          body: trimmed,
        });
        await tx.threads.touchLastMessage(thread.id, nowIso());
        return created;
      });

      await audit.record(
        { id: user.id, role: user.role },
        AuditAction.MESSAGE_SEND,
        { type: 'message', id: message.id },
        { thread_id: thread.id },
        ip,
      );

      await announce(thread, user, message);
      return { ...message, sender: toUserSummary(user) };
    },
  };
}
