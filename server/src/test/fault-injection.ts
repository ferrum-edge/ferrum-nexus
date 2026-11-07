/**
 * Fault injection for store-level tests.
 *
 * {@link faultInjectingStore} wraps a {@link NexusStore} so that one repository
 * call can be made to fail on demand, on every adapter, including inside a
 * transaction body. It exists for the tests that ask "what survives when the
 * write *after* this one fails?" — the founder's seat above all.
 */

import type { NexusStore, TransactionOptions } from '../db/store.js';

/** A store whose repository calls can be made to fail on demand. */
export interface FaultInjectingStore {
  /** The wrapped store; build the app or the service under test over this. */
  store: NexusStore;
  /**
   * Make the next call to `repo.method` reject with `error` — whether it goes
   * through the outer store or through a transaction-scoped store the wrapper
   * hands out — and behave normally again afterwards.
   */
  failNext(repo: keyof NexusStore, method: string, error?: Error): void;
  /** Fail after this many successful calls to the same repository method. */
  failAfter(repo: keyof NexusStore, method: string, successfulCalls: number, error?: Error): void;
  /** Faults armed but not yet consumed, as `repo.method`. */
  pending(): string[];
}

/**
 * Wrap a store so that individual repository calls can be made to fail once.
 *
 * Patching a method on `store.users` is enough on SQLite, whose transaction
 * bodies receive the same store object, but the pooled adapters hand every body
 * a fresh transaction-scoped store, so a patch on the outer one never fires
 * inside a transaction. This wrapper follows the store into `transaction()` and
 * wraps what comes out, which is what lets one test drive "the insert after the
 * account succeeded failed" identically on every adapter. Reads through it are
 * unaffected while nothing is armed, so assertions can use the same object.
 */
export function faultInjectingStore(base: NexusStore): FaultInjectingStore {
  const armed = new Map<string, { error: Error; remaining: number }>();

  function wrapRepo(repoName: string, repo: object): object {
    return new Proxy(repo, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof property !== 'string' || typeof value !== 'function') return value;
        const faultKey = `${repoName}.${property}`;
        return (...args: unknown[]): unknown => {
          const fault = armed.get(faultKey);
          if (fault?.remaining === 0) {
            armed.delete(faultKey);
            return Promise.reject(fault.error);
          }
          const result: unknown = Reflect.apply(value, target, args);
          if (!fault) return result;
          return Promise.resolve(result).then((accepted) => {
            fault.remaining -= 1;
            return accepted;
          });
        };
      },
    });
  }

  function wrapStore(store: NexusStore): NexusStore {
    return new Proxy(store, {
      get(target, property, receiver) {
        if (property === 'transaction') {
          return <T>(
            fn: (tx: NexusStore) => Promise<T>,
            options?: TransactionOptions,
          ): Promise<T> => target.transaction((tx) => fn(wrapStore(tx)), options);
        }
        const value: unknown = Reflect.get(target, property, receiver);
        // Store-level methods (init, migrate, close, healthCheck) run against
        // the real object; repositories are wrapped so their calls can fail.
        if (typeof value === 'function') return value.bind(target);
        if (typeof property === 'string' && value !== null && typeof value === 'object') {
          return wrapRepo(property, value);
        }
        return value;
      },
    });
  }

  return {
    store: wrapStore(base),
    failNext(repo, method, error = new Error(`injected failure in ${String(repo)}.${method}`)) {
      armed.set(`${String(repo)}.${method}`, { error, remaining: 0 });
    },
    failAfter(
      repo,
      method,
      successfulCalls,
      error = new Error(`injected failure in ${String(repo)}.${method}`),
    ) {
      armed.set(`${String(repo)}.${method}`, { error, remaining: successfulCalls });
    },
    pending() {
      return [...armed.keys()];
    },
  };
}

/** A store that can be made to stop answering, as a process that crashed would. */
export interface CrashingStore {
  /** The wrapped store; build the app that crashes over this. */
  store: NexusStore;
  /**
   * Crash once the outermost transaction that calls `repo.method` commits:
   * from then on every repository call through {@link CrashingStore.store}
   * rejects, inside transactions included, until {@link CrashingStore.revive}.
   * This is "the process stopped right after this commit".
   */
  crashAfterCommitOf(repo: keyof NexusStore, method: string): void;
  /**
   * Crash at the next call to `repo.method`: that call and every later one
   * reject. This is "the process stopped just before this write".
   */
  crashAt(repo: keyof NexusStore, method: string): void;
  /**
   * Stall at the next call to `repo.method`, as a process paused by a long GC
   * or a frozen VM would: the call waits until `resume()`, then runs. Only
   * this store's callers stall; another app over the same database does not.
   */
  stallAt(repo: keyof NexusStore, method: string): { reached: Promise<void>; resume(): void };
  /** Whether the crash has happened. */
  crashed(): boolean;
  /** Answer normally again, so the crashed app can be closed cleanly. */
  revive(): void;
}

/**
 * Wrap a store so that, at a chosen point, it stops answering — the durable
 * state is exactly what had committed, and nothing after it runs.
 *
 * Lease calls keep working. A crashed process's leases expire after their TTL;
 * letting the crashed section release them instead keeps a replacement
 * instance, built over the same underlying store, from waiting out the TTL.
 * Nothing else the crashed app does after the crash reaches the database.
 */
export function crashingStore(base: NexusStore): CrashingStore {
  let dead = false;
  let afterCommitOf: string | null = null;
  let at: string | null = null;
  /** Set while a transaction body has called the armed method. */
  let pendingCrash = false;
  let stall: { key: string; reach: () => void; resumed: Promise<void> } | null = null;
  let depth = 0;

  const crash = (): Error => new Error('the process crashed');

  function wrapRepo(repoName: string, repo: object): object {
    return new Proxy(repo, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof property !== 'string' || typeof value !== 'function') return value;
        if (repoName === 'leases') return value.bind(target);
        const key = `${repoName}.${property}`;
        return (...args: unknown[]): unknown => {
          if (at === key) {
            at = null;
            dead = true;
          }
          if (dead) return Promise.reject(crash());
          if (afterCommitOf === key) pendingCrash = true;
          if (stall?.key === key) {
            const held = stall;
            stall = null;
            held.reach();
            return held.resumed.then(() => Reflect.apply(value, target, args));
          }
          return Reflect.apply(value, target, args);
        };
      },
    });
  }

  function wrapStore(store: NexusStore): NexusStore {
    return new Proxy(store, {
      get(target, property, receiver) {
        if (property === 'transaction') {
          return async <T>(
            fn: (tx: NexusStore) => Promise<T>,
            options?: TransactionOptions,
          ): Promise<T> => {
            if (dead) throw crash();
            depth += 1;
            try {
              // Each attempt of a re-run body starts without the mark: only the
              // attempt that commits counts.
              const result = await target.transaction((tx) => {
                if (depth === 1) pendingCrash = false;
                return fn(wrapStore(tx));
              }, options);
              if (depth === 1 && pendingCrash && afterCommitOf !== null) {
                afterCommitOf = null;
                pendingCrash = false;
                dead = true;
              }
              return result;
            } finally {
              depth -= 1;
            }
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value === 'function') return value.bind(target);
        if (typeof property === 'string' && value !== null && typeof value === 'object') {
          return wrapRepo(property, value);
        }
        return value;
      },
    });
  }

  return {
    store: wrapStore(base),
    crashAfterCommitOf(repo, method) {
      afterCommitOf = `${String(repo)}.${method}`;
    },
    crashAt(repo, method) {
      at = `${String(repo)}.${method}`;
    },
    stallAt(repo, method) {
      let reach!: () => void;
      let resume!: () => void;
      const reached = new Promise<void>((resolve) => {
        reach = resolve;
      });
      const resumed = new Promise<void>((resolve) => {
        resume = resolve;
      });
      stall = { key: `${String(repo)}.${method}`, reach, resumed };
      return { reached, resume };
    },
    crashed: () => dead,
    revive() {
      dead = false;
      afterCommitOf = null;
      at = null;
      pendingCrash = false;
    },
  };
}
