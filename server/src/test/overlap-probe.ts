/**
 * Overlap probe for "these reads go out together" tests.
 *
 * {@link overlapProbe} wraps a {@link NexusStore} so a test can arm a group of
 * repository calls that must be in flight at the same time. The first matching
 * call to each member is held until every member of the group has started; a
 * member still waiting after `timeoutMs` rejects. A request path that awaits
 * the members one after another therefore fails instead of passing quietly:
 * the first read never returns, so the second is never issued.
 *
 * Only the root store is probed. Transaction bodies run against the unwrapped
 * store, so a probed call can never be held while a transaction is open.
 */

import type { NexusStore } from '../db/store.js';

/** One repository call a group waits for. */
export interface ProbeCall {
  repo: keyof NexusStore & string;
  method: string;
  /** Narrow to calls with these arguments, e.g. one settings key. */
  match?: (args: readonly unknown[]) => boolean;
}

/** A store whose repository calls can be required to overlap. */
export interface OverlapProbe {
  /** The wrapped store; build the app over this. */
  store: NexusStore;
  /**
   * Arm a group. Resolves once every member has started, and rejects if any
   * member is left waiting longer than `timeoutMs` for the others.
   */
  expectOverlap(calls: readonly ProbeCall[], timeoutMs?: number): Promise<void>;
}

interface Group {
  members: readonly ProbeCall[];
  started: boolean[];
  timeoutMs: number;
  timer: NodeJS.Timeout | null;
  settled: boolean;
  allStarted: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

/** Wrap `base` so groups of repository calls can be required to overlap. */
export function overlapProbe(base: NexusStore): OverlapProbe {
  const groups: Group[] = [];

  /** Claim the first unstarted member matching this call, if any group is armed. */
  function claim(repo: string, method: string, args: readonly unknown[]): Group | undefined {
    for (const group of groups) {
      if (group.settled) continue;
      const index = group.members.findIndex(
        (member, at) =>
          !group.started[at] &&
          member.repo === repo &&
          member.method === method &&
          (member.match?.(args) ?? true),
      );
      if (index === -1) continue;
      group.started[index] = true;
      if (group.started.every(Boolean)) {
        group.settled = true;
        if (group.timer) clearTimeout(group.timer);
        group.resolve();
      } else if (!group.timer) {
        group.timer = setTimeout(() => {
          if (group.settled) return;
          group.settled = true;
          const missing = group.members
            .filter((_, at) => !group.started[at])
            .map((member) => `${member.repo}.${member.method}`);
          group.reject(
            new Error(`expected overlapping reads, but ${missing.join(', ')} never started`),
          );
        }, group.timeoutMs);
      }
      return group;
    }
    return undefined;
  }

  function wrapRepo(repoName: string, repo: object): object {
    return new Proxy(repo, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof property !== 'string' || typeof value !== 'function') return value;
        return (...args: unknown[]): unknown => {
          const group = claim(repoName, property, args);
          if (!group) return Reflect.apply(value, target, args);
          return group.allStarted.then(() => Reflect.apply(value, target, args));
        };
      },
    });
  }

  const store = new Proxy(base, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value === 'function') return value.bind(target);
      if (typeof property === 'string' && value !== null && typeof value === 'object') {
        return wrapRepo(property, value);
      }
      return value;
    },
  });

  return {
    store,
    expectOverlap(calls, timeoutMs = 1_000) {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const allStarted = new Promise<void>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
      });
      // Held calls chain off `allStarted`; this keeps a rejection the test has
      // not awaited yet from surfacing as an unhandled one.
      allStarted.catch(() => undefined);
      groups.push({
        members: calls,
        started: calls.map(() => false),
        timeoutMs,
        timer: null,
        settled: false,
        allStarted,
        resolve,
        reject,
      });
      return allStarted;
    },
  };
}
