/**
 * Fault injection for store-level tests.
 *
 * {@link faultInjectingStore} wraps a {@link NexusStore} so that one repository
 * call can be made to fail on demand, on every adapter, including inside a
 * transaction body. It exists for the tests that ask "what survives when the
 * write *after* this one fails?" — the founder's seat above all.
 */

import type { NexusStore } from '../db/store.js';

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
  const armed = new Map<string, Error>();

  function wrapRepo(repoName: string, repo: object): object {
    return new Proxy(repo, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof property !== 'string' || typeof value !== 'function') return value;
        const faultKey = `${repoName}.${property}`;
        return (...args: unknown[]): unknown => {
          const fault = armed.get(faultKey);
          if (fault) {
            armed.delete(faultKey);
            return Promise.reject(fault);
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
          return <T>(fn: (tx: NexusStore) => Promise<T>): Promise<T> =>
            target.transaction((tx) => fn(wrapStore(tx)));
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
      armed.set(`${String(repo)}.${method}`, error);
    },
    pending() {
      return [...armed.keys()];
    },
  };
}
