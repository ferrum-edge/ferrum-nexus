/**
 * Abuse controls on `GET /api/branding` — GHSA-pxq8-x5j3-qfvh (surface A).
 *
 * The limiter is forced off under `NEXUS_ENV=test`, so the limiter suite boots
 * a `development` app with `NEXUS_RATE_LIMIT_ENABLED=true`.
 */

import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import type { ApiErrorBody, BrandingResponse } from '@ferrum-nexus/shared';

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

describe('branding cache invalidation', () => {
  let harness: TestApp;

  beforeEach(async () => {
    harness = await buildTestApp({
      env: { NEXUS_BRANDING_CACHE_MS: '60000', NEXUS_LOG_LEVEL: 'silent' },
      deps: { startOutboxWorker: false },
    });
  });

  afterEach(async () => {
    await harness.close();
  });

  it('shows a branding update on the next GET with a new ETag', async () => {
    const admin = await harness.registerUser();
    const first = await harness.app.inject({ method: 'GET', url: '/api/branding' });
    assert.equal(first.statusCode, 200, first.body);
    assert.ok(first.headers.etag);

    const updated = await harness.authed(admin, {
      method: 'PUT',
      url: '/api/admin/settings',
      payload: { branding: { portal_name: 'Fresh Gateway' } },
    });
    assert.equal(updated.statusCode, 200, updated.body);

    const next = await harness.app.inject({ method: 'GET', url: '/api/branding' });
    assert.equal(next.statusCode, 200, next.body);
    assert.equal(next.json().portal_name, 'Fresh Gateway');
    assert.ok(next.headers.etag);
    assert.notEqual(next.headers.etag, first.headers.etag);
  });

  it('returns the updated body for If-None-Match with the old ETag', async () => {
    const admin = await harness.registerUser();
    const first = await harness.app.inject({ method: 'GET', url: '/api/branding' });
    assert.equal(first.statusCode, 200, first.body);
    const etag = first.headers.etag;
    assert.ok(etag);

    const updated = await harness.authed(admin, {
      method: 'PUT',
      url: '/api/admin/settings',
      payload: { branding: { portal_name: 'Revalidated Gateway' } },
    });
    assert.equal(updated.statusCode, 200, updated.body);

    const next = await harness.app.inject({
      method: 'GET',
      url: '/api/branding',
      headers: { 'if-none-match': etag },
    });
    assert.equal(next.statusCode, 200, next.body);
    assert.equal(next.json().portal_name, 'Revalidated Gateway');
    assert.notEqual(next.headers.etag, etag);
  });

  it('clears bootstrap_required on the next GET after seating the founder', async () => {
    const first = await harness.app.inject({ method: 'GET', url: '/api/branding' });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().bootstrap_required, true);

    const founder = await harness.registerUser();
    assert.equal(founder.user.role, 'super_admin');

    const next = await harness.app.inject({ method: 'GET', url: '/api/branding' });
    assert.equal(next.statusCode, 200, next.body);
    assert.equal(next.json().bootstrap_required, false);
    assert.notEqual(next.headers.etag, first.headers.etag);
  });

  it('invalidates CAPTCHA and registration policy after direct service writes', async () => {
    const admin = await harness.registerUser();
    const first = await harness.app.inject({ method: 'GET', url: '/api/branding' });
    assert.equal(first.statusCode, 200, first.body);

    await harness.services.settings.updateSettings(admin.user, {
      captcha: {
        enabled: true,
        provider: 'turnstile',
        site_key: 'public-site-key',
        secret_key: 'test-vendor-secret',
      },
      registration: { open_registration: false, allowed_roles: ['provider'] },
    });

    const next = await harness.app.inject({ method: 'GET', url: '/api/branding' });
    assert.equal(next.statusCode, 200, next.body);
    assert.equal(next.json().captcha.enabled, true);
    assert.equal(next.json().captcha.site_key, 'public-site-key');
    assert.deepEqual(next.json().registration, {
      open_registration: false,
      allowed_roles: ['provider'],
    });
    assert.notEqual(next.headers.etag, first.headers.etag);

    await harness.services.settings.updateSettings(admin.user, {
      captcha: { enabled: false, secret_key: null },
    });
    const disabled = await harness.app.inject({ method: 'GET', url: '/api/branding' });
    assert.equal(disabled.statusCode, 200, disabled.body);
    assert.equal(disabled.json().captcha.enabled, false);
    assert.notEqual(disabled.headers.etag, next.headers.etag);
  });

  it('does not reuse an assembly started before a committed write', async (t) => {
    const admin = await harness.registerUser();
    const settings = harness.services.settings;
    const getBranding = settings.getBranding;
    let release: () => void = () => {};
    let started: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    let firstRead = true;
    t.mock.method(settings, 'getBranding', async () => {
      const value = await getBranding();
      if (firstRead) {
        firstRead = false;
        started();
        await blocked;
      }
      return value;
    });

    const overlapping = harness.app.inject({ method: 'GET', url: '/api/branding' }).then((r) => r);
    try {
      await reading;
      await settings.updateSettings(admin.user, { branding: { portal_name: 'Committed Gateway' } });
      const next = await harness.app.inject({ method: 'GET', url: '/api/branding' });
      assert.equal(next.statusCode, 200, next.body);
      assert.equal(next.json().portal_name, 'Committed Gateway');
    } finally {
      release();
    }

    const completed = await overlapping;
    assert.equal(completed.statusCode, 200, completed.body);
    assert.equal(completed.json().portal_name, 'Committed Gateway');
    const cached = await harness.app.inject({ method: 'GET', url: '/api/branding' });
    assert.equal(cached.statusCode, 200, cached.body);
    assert.equal(cached.json().portal_name, 'Committed Gateway');
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

  it('coalesces the database-backed bootstrap check for anonymous bursts', async () => {
    const users = harness.store.users;
    const countActiveSuperAdmins = users.countActiveSuperAdmins.bind(users);
    let calls = 0;
    users.countActiveSuperAdmins = async (excludeUserId?: string): Promise<number> => {
      calls += 1;
      return countActiveSuperAdmins(excludeUserId);
    };

    try {
      const responses = await Promise.all(
        Array.from({ length: 20 }, () =>
          harness.app.inject({ method: 'GET', url: '/api/branding' }),
        ),
      );
      assert.ok(responses.every((response) => response.statusCode === 200));
      assert.equal(calls, 1);
    } finally {
      users.countActiveSuperAdmins = countActiveSuperAdmins;
    }
  });

  it('briefly holds a taken founder seat across sequential and conditional requests', async () => {
    const seated = await buildTestApp({
      env: { NEXUS_BRANDING_CACHE_MS: '5000', NEXUS_LOG_LEVEL: 'silent' },
      deps: { startOutboxWorker: false },
    });
    // The founder seat is the steady state this bounds: once it is taken the
    // answer cannot flip back, so anonymous traffic may share one count query.
    await seated.registerUser();
    const users = seated.store.users;
    const countActiveSuperAdmins = users.countActiveSuperAdmins.bind(users);
    let calls = 0;
    users.countActiveSuperAdmins = async (excludeUserId?: string): Promise<number> => {
      calls += 1;
      return countActiveSuperAdmins(excludeUserId);
    };

    try {
      const first = await seated.app.inject({ method: 'GET', url: '/api/branding' });
      assert.equal(first.statusCode, 200, first.body);
      assert.equal(first.json<BrandingResponse>().bootstrap_required, false);
      const etag = first.headers.etag;
      assert.ok(etag);

      for (let request = 0; request < 5; request += 1) {
        const response = await seated.app.inject({ method: 'GET', url: '/api/branding' });
        assert.equal(response.statusCode, 200, response.body);
      }
      const conditional = await seated.app.inject({
        method: 'GET',
        url: '/api/branding',
        headers: { 'if-none-match': etag },
      });
      assert.equal(conditional.statusCode, 304, conditional.body);
      assert.equal(calls, 1, 'a taken seat is counted once per cache window');
    } finally {
      users.countActiveSuperAdmins = countActiveSuperAdmins;
      await seated.close();
    }
  });

  it('never holds an open founder seat, only coalesces the burst', async () => {
    const open = await buildTestApp({
      env: { NEXUS_BRANDING_CACHE_MS: '5000', NEXUS_LOG_LEVEL: 'silent' },
      deps: { startOutboxWorker: false },
    });
    const users = open.store.users;
    const countActiveSuperAdmins = users.countActiveSuperAdmins.bind(users);
    let calls = 0;
    users.countActiveSuperAdmins = async (excludeUserId?: string): Promise<number> => {
      calls += 1;
      return countActiveSuperAdmins(excludeUserId);
    };

    try {
      // Another instance over the same rows may claim the seat between any two
      // requests, so a settled `true` is never reused: each read hits the row.
      for (let request = 0; request < 3; request += 1) {
        const response = await open.app.inject({ method: 'GET', url: '/api/branding' });
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.json<BrandingResponse>().bootstrap_required, true);
      }
      assert.equal(calls, 3, 'an open seat is re-read on every sequential request');

      const burst = await Promise.all(
        Array.from({ length: 10 }, () => open.app.inject({ method: 'GET', url: '/api/branding' })),
      );
      assert.ok(burst.every((response) => response.statusCode === 200));
      assert.equal(calls, 4, 'a concurrent burst still collapses onto one query');
    } finally {
      users.countActiveSuperAdmins = countActiveSuperAdmins;
      await open.close();
    }
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
