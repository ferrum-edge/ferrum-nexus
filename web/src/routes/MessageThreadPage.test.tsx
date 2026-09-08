/**
 * The merge behind "Load older messages" and the cursor state that drives it.
 *
 * A thread is served one window at a time from its newest end, so the page
 * holds two moving sources: the newest window, which slides forward every time
 * somebody replies, and the older windows it has fetched by cursor. Replacing
 * one with the other loses messages — the one that has just slid out of the
 * newest window is in neither source — so the page folds them together by id
 * instead. These cases pin that down.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Message, MessagePage, MessageThreadDetail } from '@ferrum-nexus/shared';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { threadsApi } from '../lib/api';
import { queryKeys } from '../hooks/keys';
import {
  MessageThreadPage,
  adoptNewestPageCursors,
  adoptOlderPageCursors,
  initialThreadPageCursors,
  loadOlderCursor,
  mergeMessages,
} from './MessageThreadPage';

const route = vi.hoisted(() => ({ threadId: 'thread-1' }));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }): ReactElement => (
    <a href={to}>{children}</a>
  ),
  useParams: (): { threadId: string } => route,
}));

vi.mock('../stores/auth', () => ({
  useAuth: (): { user: { id: string; display_name: string } } => ({
    user: { id: 'user-1', display_name: 'You' },
  }),
}));

vi.mock('../lib/api', () => ({
  threadsApi: {
    get: vi.fn(),
    messages: vi.fn(),
    sendMessage: vi.fn(),
  },
}));

function message(id: string, createdAt: string): Message {
  return {
    id,
    thread_id: 'thread-1',
    sender_user_id: 'user-1',
    body: `body ${id}`,
    broadcast: false,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

const at = (seconds: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();

function compareMessages(a: Message, b: Message): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** Mirror the server's newest-first cursor paging for tests. */
function pageMessages(all: Message[], limit: number, before?: string): MessagePage {
  const sorted = [...all].sort(compareMessages);
  let end = sorted.length;
  if (before) {
    const index = sorted.findIndex((entry) => entry.id === before);
    expect(index).toBeGreaterThan(0);
    end = index;
  }
  const start = Math.max(0, end - limit);
  const items = sorted.slice(start, end);
  const hasMore = start > 0;
  return {
    items,
    total: sorted.length,
    has_more: hasMore,
    next_before: hasMore ? (items[0]?.id ?? null) : null,
  };
}

function threadDetail(page: MessagePage): MessageThreadDetail {
  return {
    id: 'thread-1',
    subject: 'Support',
    api_id: null,
    created_by: 'user-1',
    participant_a: 'user-1',
    participant_b: 'user-2',
    last_message_at: page.items.at(-1)?.created_at ?? null,
    created_at: at(0),
    updated_at: at(0),
    participants: [
      { id: 'user-1', display_name: 'You', email: 'you@example.test', role: 'client' },
      { id: 'user-2', display_name: 'Provider', email: 'p@example.test', role: 'provider' },
    ],
    messages: page,
  };
}

/** Replay the page's merge + cursor rules against an in-memory transcript. */
function collectReachableIds(
  all: Message[],
  limit: number,
  midSessionCount: number,
  maxOlderLoads: number,
): string[] {
  let held: Message[] = [];
  let cursors = initialThreadPageCursors();

  const adoptNewest = (page: MessagePage): void => {
    cursors = adoptNewestPageCursors(cursors, held, page);
    held = mergeMessages(held, page.items);
  };

  const adoptOlder = (page: MessagePage): void => {
    cursors = adoptOlderPageCursors(cursors, held, page);
    held = mergeMessages(held, page.items);
  };

  adoptNewest(pageMessages(all.slice(0, midSessionCount), limit));

  adoptNewest(pageMessages(all, limit));

  for (let click = 0; click < maxOlderLoads; click += 1) {
    const before = loadOlderCursor(cursors);
    if (!before) break;
    adoptOlder(pageMessages(all, limit, before));
  }

  return held.map((entry) => entry.id);
}

const clients: QueryClient[] = [];

function renderThread(): { client: QueryClient; rerenderThread: () => void } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const element = (
    <QueryClientProvider client={client}>
      <MessageThreadPage />
    </QueryClientProvider>
  );
  const { rerender } = render(element);
  return {
    client,
    rerenderThread: () =>
      rerender(
        <QueryClientProvider client={client}>
          <MessageThreadPage />
        </QueryClientProvider>,
      ),
  };
}

describe('mergeMessages', () => {
  it('prepends an older window in reading order', () => {
    const newest = [message('c', at(3)), message('d', at(4))];
    const older = [message('a', at(1)), message('b', at(2))];

    expect(mergeMessages(newest, older).map((entry) => entry.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps one copy of a message present in both windows', () => {
    const first = [message('a', at(1)), message('b', at(2))];
    const overlapping = [message('b', at(2)), message('c', at(3))];

    expect(mergeMessages(first, overlapping).map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps a message the newest window has slid past', () => {
    const before = [message('a', at(1)), message('b', at(2))];
    // A reply arrives and the server's newest window no longer carries `a`.
    const afterReply = [message('b', at(2)), message('c', at(3))];

    expect(mergeMessages(before, afterReply).map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
  });

  it('tie-breaks equal timestamps on id, matching the server order', () => {
    const merged = mergeMessages(
      [message('m2', at(1)), message('m1', at(1))],
      [message('m3', at(1)), message('m0', at(0))],
    );

    expect(merged.map((entry) => entry.id)).toEqual(['m0', 'm1', 'm2', 'm3']);
  });
});

describe('thread page cursors', () => {
  it('opens a head gap when a refetched newest window does not overlap', () => {
    const held = [message('m8', at(8)), message('m9', at(9))];
    const page = {
      items: [message('m16', at(16)), message('m17', at(17))],
      next_before: 'm16',
    };

    expect(adoptNewestPageCursors(initialThreadPageCursors(), held, page)).toEqual({
      headCursor: 'm16',
      olderCursors: ['m16'],
    });
  });

  it('keeps walking a gap until message ids overlap, even with equal timestamps', () => {
    const cursors = {
      headCursor: 'm16',
      olderCursors: ['m16', 'm08'],
    };
    const held = [message('m08', at(1)), message('m09', at(1)), message('m16', at(1))];
    const page = {
      items: [message('m11', at(1)), message('m12', at(1)), message('m13', at(1))],
      next_before: 'm11',
    };

    const advanced = adoptOlderPageCursors(cursors, held, page);
    expect(advanced).toEqual({
      headCursor: 'm16',
      olderCursors: ['m11', 'm08'],
    });
    expect(
      adoptOlderPageCursors(advanced, mergeMessages(held, page.items), {
        items: [message('m09', at(1)), message('m10', at(1))],
        next_before: 'm09',
      }),
    ).toEqual({ headCursor: 'm16', olderCursors: ['m08'] });
  });

  it('preserves an open gap on overlapping refetches and queues successive bursts', () => {
    const held = [message('m08', at(8)), message('m16', at(16))];
    const cursors = { headCursor: 'm16', olderCursors: ['m16', 'm08'] };
    const refreshed = adoptNewestPageCursors(cursors, held, {
      items: [message('m16', at(16)), message('m17', at(17))],
      next_before: 'm16',
    });
    expect(refreshed).toEqual(cursors);
    const burst = adoptNewestPageCursors(refreshed, held, {
      items: [message('m24', at(24))],
      next_before: 'm24',
    });
    expect(burst).toEqual({ headCursor: 'm24', olderCursors: ['m24', 'm16', 'm08'] });

    // An in-flight response advances its own cursor, not the new gap's cursor.
    expect(
      adoptOlderPageCursors(
        burst,
        held,
        { items: [message('m12', at(12))], next_before: 'm12' },
        'm16',
      ),
    ).toEqual({ headCursor: 'm24', olderCursors: ['m24', 'm12', 'm08'] });
  });

  it('exhausts a gap at the end of history without reviving the live head cursor', () => {
    const held = [message('m08', at(8)), message('m16', at(16))];
    const exhausted = adoptOlderPageCursors(
      { headCursor: 'm16', olderCursors: ['m16', 'm08'] },
      held,
      { items: [message('m01', at(1))], next_before: null },
    );
    expect(loadOlderCursor(exhausted)).toBeNull();
    const refreshed = adoptNewestPageCursors(exhausted, held, {
      items: [message('m16', at(16)), message('m17', at(17))],
      next_before: 'm16',
    });
    expect(refreshed.headCursor).toBe('m16');
    expect(loadOlderCursor(refreshed)).toBeNull();
  });
});

describe('mid-session gap replay', () => {
  it('reaches every message after twenty arrive and ten load-older clicks', () => {
    const all = Array.from({ length: 20 }, (_, index) => message(`m${index + 1}`, at(index + 1)));

    const reachable = collectReachableIds(all, 5, 12, 10);
    expect(reachable).toEqual(all.map((entry) => entry.id));
  });

  it('still pages quietly through history when the newest window keeps overlapping', () => {
    const all = Array.from({ length: 12 }, (_, index) => message(`m${index + 1}`, at(index + 1)));

    const reachable = collectReachableIds(all, 5, 12, 10);
    expect(reachable).toEqual(all.map((entry) => entry.id));
  });
});

describe('MessageThreadPage', () => {
  beforeEach(() => {
    route.threadId = 'thread-1';
    vi.mocked(threadsApi.get).mockReset();
    vi.mocked(threadsApi.messages).mockReset();
  });

  afterEach(() => {
    cleanup();
    for (const client of clients.splice(0)) client.clear();
  });

  it('renders every message after a mid-session burst and repeated load-older clicks', async () => {
    const all = Array.from({ length: 20 }, (_, index) => message(`m${index + 1}`, at(index + 1)));
    const limit = 5;
    let newestPage = pageMessages(all.slice(0, 12), limit);

    vi.mocked(threadsApi.get).mockImplementation(async () => threadDetail(newestPage));
    vi.mocked(threadsApi.messages).mockImplementation(async (_id, query) => {
      expect(query?.before).toBeTruthy();
      return pageMessages(all, limit, query?.before);
    });

    const { client } = renderThread();

    await screen.findByText('body m12');
    expect(screen.queryByText('body m15')).not.toBeInTheDocument();

    newestPage = pageMessages(all, limit);
    await client.invalidateQueries({ queryKey: queryKeys.threads.detail('thread-1') });

    await waitFor(() => {
      expect(screen.getByText(/Showing 10 of 20 messages/)).toBeInTheDocument();
    });

    for (let click = 0; click < 10; click += 1) {
      const loadButton = screen.queryByRole('button', { name: 'Load older messages' });
      if (!loadButton) break;
      fireEvent.click(loadButton);
      await waitFor(() => expect(threadsApi.messages).toHaveBeenCalledTimes(click + 1));
      await waitFor(() => {
        const button = screen.queryByRole('button', { name: 'Load older messages' });
        if (button) expect(button).not.toBeDisabled();
      });
    }

    for (const entry of all) {
      expect(screen.getByText(entry.body)).toBeInTheDocument();
    }
    expect(screen.getByText(/Showing 20 of 20 messages/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load older messages' })).not.toBeInTheDocument();
  });

  it('pages backwards on a quiet thread without extra newest-window churn', async () => {
    const all = Array.from({ length: 12 }, (_, index) => message(`m${index + 1}`, at(index + 1)));
    const limit = 5;

    vi.mocked(threadsApi.get).mockResolvedValue(threadDetail(pageMessages(all, limit)));
    vi.mocked(threadsApi.messages).mockImplementation(async (_id, query) =>
      pageMessages(all, limit, query?.before),
    );

    renderThread();

    await screen.findByText('body m12');
    expect(threadsApi.get).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Load older messages' }));
    await screen.findByText('body m7');

    fireEvent.click(screen.getByRole('button', { name: 'Load older messages' }));
    await screen.findByText('body m1');

    expect(threadsApi.get).toHaveBeenCalledTimes(1);
    expect(vi.mocked(threadsApi.messages)).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Showing 12 of 12 messages')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load older messages' })).not.toBeInTheDocument();
  });

  it('resets held messages and pending gaps when switching threads', async () => {
    const all = Array.from({ length: 20 }, (_, index) => message(`m${index + 1}`, at(index + 1)));
    let newestPage = pageMessages(all.slice(0, 12), 5);
    const other = { ...message('other', at(1)), thread_id: 'thread-2' };
    vi.mocked(threadsApi.get).mockImplementation(async (id) =>
      id === 'thread-1'
        ? threadDetail(newestPage)
        : { ...threadDetail(pageMessages([other], 5)), id: 'thread-2' },
    );

    const { client, rerenderThread } = renderThread();
    await screen.findByText('body m12');
    newestPage = pageMessages(all, 5);
    await client.invalidateQueries({ queryKey: queryKeys.threads.detail('thread-1') });
    await screen.findByText('Showing 10 of 20 messages');

    route.threadId = 'thread-2';
    rerenderThread();
    await screen.findByText('body other');
    expect(screen.getByText('Showing 1 of 1 messages')).toBeInTheDocument();
    expect(screen.queryByText('body m12')).not.toBeInTheDocument();
    expect(screen.queryByText('body m20')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load older messages' })).not.toBeInTheDocument();
  });
});
