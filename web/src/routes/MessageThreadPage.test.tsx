/**
 * The merge behind "Load older messages".
 *
 * A thread is served one window at a time from its newest end, so the page
 * holds two moving sources: the newest window, which slides forward every time
 * somebody replies, and the older windows it has fetched by cursor. Replacing
 * one with the other loses messages — the one that has just slid out of the
 * newest window is in neither source — so the page folds them together by id
 * instead. These cases pin that down.
 */

import { describe, expect, it } from 'vitest';
import type { Message } from '@ferrum-nexus/shared';

import { mergeMessages } from './MessageThreadPage';

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

const at = (seconds: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();

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
