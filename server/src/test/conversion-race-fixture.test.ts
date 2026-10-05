import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createConversionRaceFixture } from './conversion-race-fixture.js';

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

test('conversion fixture requires the first mutation and closes both apps', async (t) => {
  const fixture = createConversionRaceFixture(t.signal);
  const closed: string[] = [];
  const body = 'Atomic conversion teardown is unavailable: conditional_proxy_cascade';
  try {
    const request = fixture.own(Promise.resolve({ statusCode: 409, body }));
    await assert.rejects(fixture.waitFor(neverAnnounced(), request, 'first gateway mutation'), {
      name: 'AssertionError',
      actual: 409,
      expected: 200,
      message: /conditional_proxy_cascade/,
    });
    const premature = fixture.own(Promise.resolve({ statusCode: 200, body: '' }));
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
    (async () => {
      await fixture.held;
      events.push('first settled');
      return { statusCode: 200, body: '' };
    })(),
  );
  try {
    const second = fixture.own(Promise.reject(failure));
    await assert.rejects(
      fixture.waitFor(neverAnnounced(), second, 'second proxy lease contention'),
      (error: unknown) => error === failure,
    );
  } finally {
    await fixture.cleanup(recordClose(events, 'two closed'), recordClose(events, 'one closed'));
  }
  assert.equal((await first).statusCode, 200);
  assert.deepEqual(events, ['first settled', 'two closed', 'one closed']);
});

test('conversion fixture bounds missing contention and drains a late rejection', async (t) => {
  const fixture = createConversionRaceFixture(t.signal, 25);
  const events: string[] = [];
  const request = fixture.own(
    (async () => {
      await fixture.held;
      events.push('request settled');
      throw new Error('released request failed');
    })(),
  );
  try {
    await assert.rejects(
      fixture.waitFor(neverAnnounced(), request, 'second proxy lease contention'),
      /Timed out waiting for second proxy lease contention/,
    );
  } finally {
    await fixture.cleanup(recordClose(events, 'two closed'), recordClose(events, 'one closed'));
  }
  assert.deepEqual(events, ['request settled', 'two closed', 'one closed']);
});

test('conversion fixture abort releases requests and still closes both apps', async () => {
  const controller = new AbortController();
  const fixture = createConversionRaceFixture(controller.signal);
  const events: string[] = [];
  const request = fixture.own(
    (async () => {
      await fixture.held;
      events.push('request settled');
      return { statusCode: 200, body: '' };
    })(),
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
    (async () => {
      await fixture.held;
      events.push('request settled');
      throw new Error('request rejected after the assertion');
    })(),
  );
  await assert.rejects(
    async () => {
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
          (error: unknown) => error instanceof AggregateError && error.errors[0] === failure,
        );
      }
    },
    /injected assertion failure/,
  );
  assert.deepEqual(events, ['request settled', 'two closed', 'one closed']);
});
