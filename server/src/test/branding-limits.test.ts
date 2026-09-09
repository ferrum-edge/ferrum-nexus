/**
 * Abuse controls on `GET /api/branding` — GHSA-pxq8-x5j3-qfvh (surface A).
 *
 * The limiter is forced off under `NEXUS_ENV=test`, so the limiter suite boots
 * a `development` app with `NEXUS_RATE_LIMIT_ENABLED=true`.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { ApiErrorBody } from '@ferrum-nexus/shared';

import { brandingEtag } from '../routes/branding.js';
import { buildTestApp, type TestApp } from './helpers.js';

describe('branding rate limiting', () => {
  let harness: TestApp;

  before(async () => {
    harness = await buildTestApp({
      env: {
        NEXUS_ENV: 'development',
        NEXUS_RATE_LIMIT_ENABLED: 'true',
        NEXUS_BRANDING_CACHE_MS: '5000',
        NEXUS_LOG_LEVEL: 'silent',
      },
      deps: { startOutboxWorker: false },
    });
  });

  after(async () => {
    await harness.close();
  });

  it('answers 429 RATE_LIMITED once a client exceeds the branding budget', async () => {
    const statuses: number[] = [];
    let limited: string | null = null;
    for (let attempt = 0; attempt < 130; attempt += 1) {
      const response = await harness.app.inject({ method: 'GET', url: '/api/branding' });
      statuses.push(response.statusCode);
      if (response.statusCode === 429 && limited === null) limited = response.body;
    }

    assert.equal(
      statuses.filter((status) => status === 200).length,
      120,
      `the limit is 120/minute: ${statuses.filter((status) => status === 200).length} passed`,
    );
    assert.ok(limited, 'the limiter must engage');
    assert.equal((JSON.parse(limited) as ApiErrorBody).error.code, 'RATE_LIMITED');
  });
});

describe('branding response cache', () => {
  let harness: TestApp;

  before(async () => {
    harness = await buildTestApp({
      env: { NEXUS_BRANDING_CACHE_MS: '5000', NEXUS_LOG_LEVEL: 'silent' },
      deps: { startOutboxWorker: false },
    });
  });

  after(async () => {
    await harness.close();
  });

  it('serves public cache headers and honours If-None-Match', async () => {
    const first = await harness.app.inject({ method: 'GET', url: '/api/branding' });
    assert.equal(first.statusCode, 200, first.body);
    assert.match(first.headers['cache-control'] ?? '', /^public, max-age=\d+$/);
    const etag = first.headers.etag;
    assert.ok(etag, 'expected an ETag');
    assert.equal(etag, brandingEtag(first.json()));

    const second = await harness.app.inject({
      method: 'GET',
      url: '/api/branding',
      headers: { 'if-none-match': etag },
    });
    assert.equal(second.statusCode, 304, second.body);
    assert.equal(second.headers['cache-control'], first.headers['cache-control']);
    assert.equal(second.headers.etag, etag);
  });

  it('leaves cache-control unset when NEXUS_BRANDING_CACHE_MS=0', async () => {
    const uncached = await buildTestApp({
      env: { NEXUS_BRANDING_CACHE_MS: '0', NEXUS_LOG_LEVEL: 'silent' },
      deps: { startOutboxWorker: false },
    });
    try {
      const response = await uncached.app.inject({ method: 'GET', url: '/api/branding' });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.headers.etag, undefined);
      assert.equal(response.headers['cache-control'], 'no-store');
    } finally {
      await uncached.close();
    }
  });
});
