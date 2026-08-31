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
 */

import {
  MAX_PAGE_SIZE,
  clampPageSize,
  roleAtLeast,
  type ApiSummary,
  type Message,
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
  MessageRecord,
  NexusStore,
  ThreadRecord,
  UserRecord,
} from '../db/store.js';
import type { EmailService } from '../email/service.js';
import { forbidden, notFound, validationFailed } from '../lib/errors.js';
import { nowIso } from '../lib/ids.js';
import type { NotificationsService } from '../notifications/service.js';

/** Characters of the newest message shown in list previews and emails. */
export const MESSAGE_PREVIEW_LENGTH = 160;

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
  /** One thread with its full message list. */
  getThread(user: UserRecord, threadId: Uuid): Promise<MessageThreadDetail>;
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

/** True when `user` occupies one of the thread's seats. */
export function isThreadParticipant(user: UserRecord, thread: ThreadRecord): boolean {
  return (
    thread.participant_a === user.id ||
    thread.participant_b === user.id ||
    thread.created_by === user.id
  );
}

/** A thread with an empty second seat is the platform inbox. */
export function isPlatformThread(thread: ThreadRecord): boolean {
  return thread.participant_b === null;
}

/** Build the messaging service. */
export function createMessagingService(deps: MessagingServiceDeps): MessagingService {
  const { config, store, notifications, email, audit } = deps;

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

    return Promise.all(
      threads.map(async (thread) => {
        const participants: UserSummary[] = [];
        for (const id of [thread.participant_a, thread.participant_b]) {
          const record = id ? users.get(id) : undefined;
          if (record) participants.push(toUserSummary(record));
        }
        const api = thread.api_id ? apis.get(thread.api_id) : undefined;
        const apiSummary: ApiSummary | undefined = api
          ? {
              id: api.id,
              name: api.name,
              slug: api.slug,
              version: api.version,
              owner_user_id: api.owner_user_id,
            }
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

  async function loadThread(threadId: Uuid): Promise<ThreadRecord> {
    const thread = await store.threads.findById(threadId);
    if (!thread) throw notFound('Thread', threadId);
    return thread;
  }

  /** Read access: participants always; admins for oversight and support. */
  function assertCanRead(user: UserRecord, thread: ThreadRecord): void {
    if (isThreadParticipant(user, thread)) return;
    if (roleAtLeast(user.role, 'admin')) return;
    throw forbidden('You are not a participant in this conversation');
  }

  /** Write access: participants, plus any admin answering the platform inbox. */
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

      const existing = await store.threads.findExisting(participantA, participantB, apiId);
      const thread =
        existing ??
        (await store.threads.create({
          subject,
          api_id: apiId,
          created_by: input.actor.id,
          participant_a: participantA,
          participant_b: participantB,
        }));

      const message = await store.messages.create({
        thread_id: thread.id,
        sender_user_id: input.actor.id,
        body,
      });
      const at = nowIso();
      await store.threads.touchLastMessage(thread.id, at);

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

      if (!roleAtLeast(user.role, 'admin')) {
        const page = await store.threads.list({ ...base, participant_user_id: user.id }, options);
        return { items: await decorate(page.items), total: page.total };
      }

      // Admins additionally see the platform inbox (`participant_b IS NULL`).
      // `ThreadFilter` has no predicate for that and widening `NexusStore` would
      // mean changing all four adapters, so the admin view merges one bounded
      // page and selects in memory. Support volume is small by construction.
      const limit = clampPageSize(options?.limit);
      const offset = Math.max(0, options?.offset ?? 0);
      const scan = await store.threads.list(base, { limit: MAX_PAGE_SIZE, offset: 0 });
      const visible = scan.items.filter(
        (thread) => isPlatformThread(thread) || isThreadParticipant(user, thread),
      );
      return {
        items: await decorate(visible.slice(offset, offset + limit)),
        total: visible.length,
      };
    },

    async getThread(user, threadId): Promise<MessageThreadDetail> {
      const thread = await loadThread(threadId);
      assertCanRead(user, thread);

      const page = await store.messages.listByThread(thread.id, { limit: MAX_PAGE_SIZE });
      const senders = new Map(
        (
          await store.users.findManyByIds([
            ...new Set(page.items.map((message) => message.sender_user_id)),
          ])
        ).map((record) => [record.id, record]),
      );
      const [decorated] = await decorate([thread]);
      const messages: Message[] = page.items.map((message) => {
        const sender = senders.get(message.sender_user_id);
        return sender ? { ...message, sender: toUserSummary(sender) } : { ...message };
      });
      return { ...(decorated ?? thread), messages };
    },

    async sendMessage(user, threadId, body, ip = null): Promise<Message> {
      const trimmed = body.trim();
      if (trimmed === '') throw validationFailed('A message body is required');
      const thread = await loadThread(threadId);
      assertCanPost(user, thread);

      const message = await store.messages.create({
        thread_id: thread.id,
        sender_user_id: user.id,
        body: trimmed,
      });
      await store.threads.touchLastMessage(thread.id, nowIso());

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
