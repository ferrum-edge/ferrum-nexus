import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';

import type { PublishApiResponse } from '@ferrum-nexus/shared';

import { createConversionRaceFixture, createOwnedOperation } from './conversion-race-fixture.js';
import { buildTestApp, specWithServer, testOperationSignal, type TestApp } from './helpers.js';

function neverAnnounced(): Promise<void> {
  return new Promise(() => {});
}

function recordClose(events: string[], label: string): { close(): Promise<void> } {
  return {
    async close(): Promise<void> {
      events.push(label);
    },
  };
}

function gate(): { promise: Promise<void>; release(): void } {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** A real cancellable timer: cancellation clears the resource before resolving the wait. */
async function cancellableDelay(signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  try {
    await new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 30_000);
      abort = resolve;
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

test('conversion fixture requires the first mutation and closes both apps', async (t) => {
  const fixture = createConversionRaceFixture(t.signal);
  const closed: string[] = [];
  const body = 'Atomic conversion teardown is unavailable: conditional_proxy_cascade';
  try {
    const request = fixture.own(createOwnedOperation(async () => ({ statusCode: 409, body })));
    await assert.rejects(fixture.waitFor(neverAnnounced(), request, 'first gateway mutation'), {
      name: 'AssertionError',
      actual: 409,
      expected: 200,
      message: /conditional_proxy_cascade/,
    });
    const premature = fixture.own(
      createOwnedOperation(async () => ({ statusCode: 200, body: '' })),
    );
    await assert.rejects(
      fixture.waitFor(neverAnnounced(), premature, 'first gateway mutation'),
      /Request completed before first gateway mutation/,
    );
  } finally {
    await fixture.cleanup(recordClose(closed, 'two'), recordClose(closed, 'one'));
  }
  assert.deepEqual(closed, ['two', 'one']);
});

test('conversion fixture drains held work after an early rival rejection', async (t) => {
  const fixture = createConversionRaceFixture(t.signal);
  const events: string[] = [];
  const failure = new Error('rival failed before taking the proxy lease');
  const first = fixture.own(
    createOwnedOperation(async () => {
      await fixture.held;
      events.push('first settled');
      return { statusCode: 200, body: '' };
    }),
  );
  try {
    const second = fixture.own(
      createOwnedOperation(async () => {
        throw failure;
      }),
    );
    await assert.rejects(
      fixture.waitFor(neverAnnounced(), second, 'second proxy lease contention'),
      (error: unknown) => error === failure,
    );
  } finally {
    await assert.rejects(
      fixture.cleanup(recordClose(events, 'two closed'), recordClose(events, 'one closed')),
      (error: unknown) => error instanceof AggregateError && error.errors.includes(failure),
    );
  }
  assert.equal((await first).statusCode, 200);
  assert.deepEqual(events, ['first settled', 'two closed', 'one closed']);
});

test('conversion fixture bounds missing contention and drains a late rejection', async (t) => {
  const fixture = createConversionRaceFixture(t.signal, 25);
  const events: string[] = [];
  const request = fixture.own(
    createOwnedOperation(async () => {
      await fixture.held;
      events.push('request settled');
      throw new Error('released request failed');
    }),
  );
  try {
    await assert.rejects(
      fixture.waitFor(neverAnnounced(), request, 'second proxy lease contention'),
      /Timed out waiting for second proxy lease contention/,
    );
  } finally {
    await assert.rejects(
      fixture.cleanup(recordClose(events, 'two closed'), recordClose(events, 'one closed')),
      (error: unknown) =>
        error instanceof AggregateError &&
        error.errors.some(
          (cause: unknown) => cause instanceof Error && cause.message === 'released request failed',
        ),
    );
  }
  assert.deepEqual(events, ['request settled', 'two closed', 'one closed']);
});

test('conversion fixture cancels a delayed request and joins its late rejection', async (t) => {
  const fixture = createConversionRaceFixture(t.signal, 25);
  const events: string[] = [];
  const cancelled = gate();
  const unwinding = gate();
  const failure = new Error('request failed during cancellation unwind');
  const request = fixture.own(
    createOwnedOperation(async (signal) => {
      await fixture.held;
      await cancellableDelay(signal);
      events.push('request cancelled');
      cancelled.release();
      await unwinding.promise;
      events.push('request settled');
      throw failure;
    }),
  );
  const completed = assert.rejects(
    fixture.cleanup(recordClose(events, 'two closed'), recordClose(events, 'one closed')),
    (error: unknown) =>
      error instanceof AggregateError &&
      error.errors.length === 2 &&
      error.errors.includes(failure) &&
      error.errors.some(
        (cause: unknown) =>
          cause instanceof Error && /pending requests during cleanup/.test(cause.message),
      ),
  );
  try {
    await fixture.within(cancelled.promise, 'request cancellation');
    assert.deepEqual(events, ['request cancelled']);
  } finally {
    unwinding.release();
    await completed;
  }
  await assert.rejects(request, (error: unknown) => error === failure);
  assert.deepEqual(getEventListeners(request.signal, 'abort'), []);
  assert.deepEqual(events, ['request cancelled', 'request settled', 'two closed', 'one closed']);
});

test('conversion fixture clears completed wait timers and abort listeners', async () => {
  const controller = new AbortController();
  const fixture = createConversionRaceFixture(controller.signal, 25);
  const request = fixture.own(createOwnedOperation(async () => ({ statusCode: 200, body: '' })));
  const events: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await fixture.within(request, 'completed request');
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
    await fixture.cleanup(recordClose(events, 'two'), recordClose(events, 'one'));
    assert.deepEqual(getEventListeners(controller.signal, 'abort'), []);
    controller.abort(new Error('abort after cleanup'));
    await new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 75);
    });
    assert.equal(request.signal.aborted, false, 'no completed wait cancels work later');
    assert.deepEqual(events, ['two', 'one']);
  } finally {
    clearTimeout(timer);
    await fixture.cleanup(recordClose(events, 'two'), recordClose(events, 'one'));
  }
});

for (const rejects of [false, true]) {
  test(`conversion fixture joins a late close before shared teardown, rejects: ${rejects}`, async (t) => {
    const fixture = createConversionRaceFixture(t.signal, 25);
    const events: string[] = [];
    const closing = gate();
    const finishClose = gate();
    const failure = new Error('late two close failed');
    let alarm: ReturnType<typeof setTimeout> | undefined;
    const completed = assert.rejects(
      fixture.cleanup(
        {
          async close(): Promise<void> {
            events.push('two close started');
            closing.release();
            await finishClose.promise;
            events.push('two close settled');
            if (rejects) throw failure;
          },
        },
        recordClose(events, 'one shared teardown'),
      ),
      (error: unknown) =>
        error instanceof AggregateError &&
        error.errors.length === (rejects ? 2 : 1) &&
        error.errors.includes(failure) === rejects &&
        error.errors.some(
          (cause: unknown) => cause instanceof Error && /app cleanup/.test(cause.message),
        ),
    );
    try {
      await fixture.within(closing.promise, 'two close started');
      await new Promise<void>((resolve) => {
        alarm = setTimeout(resolve, 75);
      });
      assert.deepEqual(events, ['two close started']);
    } finally {
      clearTimeout(alarm);
      finishClose.release();
      await completed;
    }
    assert.deepEqual(events, ['two close started', 'two close settled', 'one shared teardown']);
  });
}

test(
  'conversion fixture joins the injected handler before closing either real app',
  { timeout: 20_000 },
  async (t) => {
    const one = await buildTestApp();
    let two: TestApp | undefined;
    const fixture = createConversionRaceFixture(t.signal, 250);
    const events: string[] = [];
    const arrived = gate();
    const contending = gate();
    const cancelled = gate();
    const unwind = gate();
    let completed: Promise<void> | undefined;
    try {
      two = await buildTestApp({ store: one.store, edge: one.edge });
      const peer = two;
      await one.registerUser();
      const provider = await one.registerUser({ role: 'provider' });
      const published = await one.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: {
          name: 'Cleanup ownership',
          slug: 'cleanup-ownership',
          spec: specWithServer('https://v1.example.com:8443/v1'),
          auth_plugin: 'key_auth',
          requestable: true,
          visibility: 'public',
        },
      });
      assert.equal(published.statusCode, 201, published.body);
      const api = published.json<PublishApiResponse>().api;
      const realGet = one.edgeClient.proxies.get.bind(one.edgeClient.proxies);
      one.edgeClient.proxies.get = async (...args) => {
        const signal = testOperationSignal();
        assert.ok(signal);
        arrived.release();
        await fixture.held;
        await cancellableDelay(signal);
        events.push('handler cancelled');
        cancelled.release();
        await unwind.promise;
        events.push('handler unwound');
        // The captured boundary checks cancellation before it can start more HTTP work.
        return realGet(...args);
      };
      const request = fixture.own(
        one.authed(provider, {
          method: 'PATCH',
          url: `/api/apis/${api.id}`,
          payload: { allowed_methods: ['GET'] },
        }),
      );
      await fixture.waitFor(arrived.promise, request, 'gateway read');
      const serialize = peer.edgeClient.serializePerKey.bind(peer.edgeClient);
      peer.edgeClient.serializePerKey = (key, fn) => {
        if (key === `proxy:${api.ferrum_proxy_id}`) contending.release();
        return serialize(key, fn);
      };
      const rival = fixture.own(
        peer.authed(provider, {
          method: 'PATCH',
          url: `/api/apis/${api.id}`,
          payload: { allowed_methods: ['POST'] },
        }),
      );
      await fixture.waitFor(contending.promise, rival, 'rival proxy lease contention');
      completed = assert.rejects(
        fixture.cleanup(
          {
            async close(): Promise<void> {
              events.push('two close');
              await peer.close();
            },
          },
          {
            async close(): Promise<void> {
              events.push('one shared teardown');
              try {
                const key = `proxy:${api.ferrum_proxy_id}`;
                const now = new Date().toISOString();
                assert.equal(
                  await one.store.leases.acquire(
                    key,
                    'cleanup-probe',
                    new Date(Date.now() + 5_000).toISOString(),
                    now,
                  ),
                  true,
                  'the cancelled handler released its real proxy lease',
                );
                await one.store.leases.release(key, 'cleanup-probe');
              } finally {
                await one.close();
              }
            },
          },
        ),
        (error: unknown) =>
          error instanceof AggregateError &&
          error.errors.length === 1 &&
          error.errors.some(
            (cause: unknown) =>
              cause instanceof Error && /pending requests during cleanup/.test(cause.message),
          ),
      );
      await fixture.within(cancelled.promise, 'handler cancellation');
      assert.deepEqual(events, ['handler cancelled']);
      assert.equal((await fixture.within(rival, 'cancelled lease waiter')).statusCode, 500);
      events.push('rival settled');
      assert.ok(await one.store.apis.findById(api.id), 'the shared store is still open');
      unwind.release();
      await completed;
      assert.equal((await request).statusCode, 500);
      assert.deepEqual(events, [
        'handler cancelled',
        'rival settled',
        'handler unwound',
        'two close',
        'one shared teardown',
      ]);
    } finally {
      unwind.release();
      if (completed) await completed;
      else await fixture.cleanup(two, one);
    }
  },
);

test('conversion fixture abort releases requests and still closes both apps', async () => {
  const controller = new AbortController();
  const fixture = createConversionRaceFixture(controller.signal);
  const events: string[] = [];
  const request = fixture.own(
    createOwnedOperation(async () => {
      await fixture.held;
      events.push('request settled');
      return { statusCode: 200, body: '' };
    }),
  );
  try {
    const waiting = fixture.waitFor(neverAnnounced(), request, 'first gateway mutation');
    controller.abort(new Error('test timeout'));
    await assert.rejects(waiting, /Test aborted while waiting for first gateway mutation/);
  } finally {
    await fixture.cleanup(recordClose(events, 'two closed'), recordClose(events, 'one closed'));
  }
  assert.deepEqual(events, ['request settled', 'two closed', 'one closed']);
});

test('conversion fixture releases on assertion failure and attempts both closes', async (t) => {
  const fixture = createConversionRaceFixture(t.signal);
  const events: string[] = [];
  const failure = new Error('two close failed');
  fixture.own(
    createOwnedOperation(async () => {
      await fixture.held;
      events.push('request settled');
      throw new Error('request rejected after the assertion');
    }),
  );
  await assert.rejects(async () => {
    try {
      assert.fail('injected assertion failure');
    } finally {
      await assert.rejects(
        fixture.cleanup(
          {
            async close(): Promise<void> {
              events.push('two closed');
              throw failure;
            },
          },
          recordClose(events, 'one closed'),
        ),
        (error: unknown) => error instanceof AggregateError && error.errors.includes(failure),
      );
    }
  }, /injected assertion failure/);
  assert.deepEqual(events, ['request settled', 'two closed', 'one closed']);
});
