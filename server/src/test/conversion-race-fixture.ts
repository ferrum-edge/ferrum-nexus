import assert from 'node:assert/strict';

import type { LightMyRequestResponse } from 'fastify';

import type { TestApp } from './helpers.js';

type Response = Pick<LightMyRequestResponse, 'statusCode' | 'body'>;

/** Cancellation requests an unwind; the promise joins the operation, including its finally. */
export interface OwnedOperation<T> extends Promise<T> {
  readonly signal: AbortSignal;
  own(): void;
  cancel(reason: Error): void;
}

/** Factories release their waits on cancellation and await every child operation they start. */
export function createOwnedOperation<T>(
  run: (signal: AbortSignal) => Promise<T>,
  onOwn: () => void = () => {},
): OwnedOperation<T> {
  const controller = new AbortController();
  const operation = Object.assign(Promise.resolve().then(() => run(controller.signal)), {
    signal: controller.signal,
    own: onOwn,
    cancel(reason: Error): void {
      onOwn();
      controller.abort(reason);
    },
  });
  // Observe even a synchronous factory failure before a caller starts awaiting it.
  void operation.catch(() => undefined);
  return operation;
}

interface ConversionRaceFixture {
  held: Promise<void>;
  release(): void;
  own<T>(operation: OwnedOperation<T>): OwnedOperation<T>;
  within<T>(operation: Promise<T>, boundary: string): Promise<T>;
  waitFor(announcement: Promise<void>, request: Promise<Response>, boundary: string): Promise<void>;
  cleanup(...apps: (Pick<TestApp, 'close'> | undefined)[]): Promise<void>;
}

/** Bound missing announcements, cancel held work and join it before destroying shared resources. */
export function createConversionRaceFixture(
  signal: AbortSignal,
  timeoutMs = 5_000,
): ConversionRaceFixture {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending: OwnedOperation<unknown>[] = [];
  let cleanup: Promise<void> | undefined;

  function cancel(reason: Error): void {
    release();
    for (const operation of pending) operation.cancel(reason);
  }

  const abort = () => {
    cancel(new Error('Conversion race test aborted', { cause: signal.reason }));
  };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();

  async function within<T>(operation: Promise<T>, boundary: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort = () => {};
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            const error = new Error(`Timed out waiting for ${boundary}`);
            cancel(error);
            reject(error);
          }, timeoutMs);
          onAbort = () => {
            const error = new Error(`Test aborted while waiting for ${boundary}`, {
              cause: signal.reason,
            });
            cancel(error);
            reject(error);
          };
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
        }),
      ]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  async function drain(apps: (Pick<TestApp, 'close'> | undefined)[]): Promise<void> {
    release();
    const errors: unknown[] = [];
    // A deadline cancels the work, never its join. Fastify injection is kept alive
    // until the handler unwinds; aborting its transport would not cancel that handler.
    const timer = setTimeout(() => {
      const error = new Error('Timed out waiting for pending requests during cleanup');
      errors.push(error);
      cancel(error);
    }, timeoutMs);
    try {
      const results = await Promise.allSettled(pending);
      for (const [index, result] of results.entries()) {
        if (result.status === 'rejected' && result.reason !== pending[index]?.signal.reason) {
          errors.push(result.reason);
        }
      }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }

    for (const app of apps) {
      if (!app) continue;
      // close() is not cancellable. Its original promise must settle before the
      // next app can close the shared store/gateway, even after a slow-close alarm.
      const closeTimer = setTimeout(() => {
        errors.push(new Error('Timed out waiting for app cleanup'));
      }, timeoutMs);
      try {
        await app.close();
      } catch (error) {
        errors.push(error);
      } finally {
        clearTimeout(closeTimer);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Conversion race cleanup failed');
  }

  return {
    held,
    release,
    own<T>(operation: OwnedOperation<T>): OwnedOperation<T> {
      assert.equal(cleanup, undefined, 'Cannot start owned work during cleanup');
      operation.own();
      pending.push(operation);
      if (signal.aborted) abort();
      return operation;
    },
    within,
    async waitFor(announcement, request, boundary): Promise<void> {
      await within(
        Promise.race([
          announcement,
          request.then((response) => {
            assert.equal(response.statusCode, 200, response.body);
            assert.fail(`Request completed before ${boundary}`);
          }),
        ]),
        boundary,
      );
    },
    cleanup(...apps): Promise<void> {
      cleanup ??= drain(apps);
      return cleanup;
    },
  };
}
