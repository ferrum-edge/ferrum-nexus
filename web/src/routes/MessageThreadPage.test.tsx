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
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
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

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }): ReactElement => (
    <a href={to}>{children}</a>
  ),
  useParams: (): { threadId: string } => ({ threadId: 'thread-1' }),
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
    created_at: createdAt,
    updated_at: createdAt,
  };
}

const at = (seconds: number): string =>
  new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();

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

function renderThread(): { client: QueryClient } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <MessageThreadPage />
    </QueryClientProvider>,
  );
  return { client };
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
      headGapCursor: 'm16',
      olderCursor: null,
    });
  });

  it('clears a head gap once an older fetch overlaps held messages', () => {
    const cursors = { headCursor: 'm16', headGapCursor: 'm16', olderCursor: null };
    const held = [message('m8', at(8)), message('m9', at(9)), message('m16', at(16))];
    const page = {
      items: [message('m11', at(11)), message('m12', at(12)), message('m13', at(13))],
      next_before: 'm11',
    };

    expect(adoptOlderPageCursors(cursors, held, page)).toEqual({
      headCursor: null,
      headGapCursor: null,
      olderCursor: 'm11',
    });
  });
});

describe('mid-session gap replay', () => {
  it('reaches every message after twenty arrive and ten load-older clicks', () => {
    const all = Array.from({ length: 20 }, (_, index) =>
      message(`m${index + 1}`, at(index + 1)),
    );

    const reachable = collectReachableIds(all, 5, 12, 10);
    expect(reachable).toEqual(all.map((entry) => entry.id));
  });

  it('still pages quietly through history when the newest window keeps overlapping', () => {
    const all = Array.from({ length: 12 }, (_, index) =>
      message(`m${index + 1}`, at(index + 1)),
    );

    const reachable = collectReachableIds(all, 5, 12, 10);
    expect(reachable).toEqual(all.map((entry) => entry.id));
  });
});

describe('MessageThreadPage', () => {
  beforeEach(() => {
    vi.mocked(threadsApi.get).mockReset();
    vi.mocked(threadsApi.messages).mockReset();
  });

  afterEach(() => {
    cleanup();
    for (const client of clients.splice(0)) client.clear();
  });

  it('renders every message after a mid-session burst and repeated load-older clicks', async () => {
    const all = Array.from({ length: 20 }, (_, index) =>
      message(`m${index + 1}`, at(index + 1)),
    );
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
    }

    for (const entry of all) {
      expect(screen.getByText(entry.body)).toBeInTheDocument();
    }
    expect(screen.getByText(/Showing 20 of 20 messages/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load older messages' })).not.toBeInTheDocument();
  });

  it('pages backwards on a quiet thread without extra newest-window churn', async () => {
    const all = Array.from({ length: 12 }, (_, index) =>
      message(`m${index + 1}`, at(index + 1)),
    );
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
    expect(screen.queryByRole('button', { name: 'Load older messages' })).not.toBeInTheDocument();
  });
});
