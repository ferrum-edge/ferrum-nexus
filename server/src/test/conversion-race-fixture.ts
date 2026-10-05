import assert from 'node:assert/strict';

import type { LightMyRequestResponse } from 'fastify';

import type { TestApp } from './helpers.js';

type Response = Pick<LightMyRequestResponse, 'statusCode' | 'body'>;

interface ConversionRaceFixture {
  held: Promise<void>;
  release(): void;
  own<T>(operation: Promise<T>): Promise<T>;
  within<T>(operation: Promise<T>, boundary: string): Promise<T>;
  waitFor(announcement: Promise<void>, request: Promise<Response>, boundary: string): Promise<void>;
  cleanup(...apps: (Pick<TestApp, 'close'> | undefined)[]): Promise<void>;
}

/** Bound missing hooks and own every started request until teardown has drained it. */
export function createConversionRaceFixture(
  signal: AbortSignal,
  timeoutMs = 5_000,
): ConversionRaceFixture {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending: Promise<unknown>[] = [];
  signal.addEventListener('abort', release, { once: true });
  if (signal.aborted) release();

  async function within<T>(
    operation: Promise<T>,
    boundary: string,
    abortSignal: AbortSignal | null = signal,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort = () => {};
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            release();
            reject(new Error(`Timed out waiting for ${boundary}`));
          }, timeoutMs);
          abort = () => {
            release();
            reject(
              new Error(`Test aborted while waiting for ${boundary}`, {
                cause: abortSignal?.reason,
              }),
            );
          };
          abortSignal?.addEventListener('abort', abort, { once: true });
          if (abortSignal?.aborted) abort();
        }),
      ]);
    } finally {
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', abort);
    }
  }

  return {
    held,
    release,
    own<T>(operation: Promise<T>): Promise<T> {
      pending.push(operation);
      // Observe rejection immediately, including when another wait fails first.
      // The original promise still rejects when awaited by the test.
      void operation.catch(() => undefined);
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
    async cleanup(...apps): Promise<void> {
      release();
      signal.removeEventListener('abort', release);
      // Cleanup must still run after the test signal has been aborted.
      try {
        await within(Promise.allSettled(pending), 'pending requests during cleanup', null);
      } finally {
        const errors: unknown[] = [];
        for (const app of apps) {
          if (!app) continue;
          try {
            await within(app.close(), 'app cleanup', null);
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length > 0) throw new AggregateError(errors, 'Conversion race cleanup failed');
      }
    },
  };
}
