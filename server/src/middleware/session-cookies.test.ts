/**
 * The response-caching rule owned by `session-cookies.ts`: a response that sets
 * or clears a cookie is never storable by a shared cache, whatever directive
 * its handler wrote, on success, `304` and error paths alike.
 *
 * A bare Fastify app with the production cookie plugin and hook, so each route
 * can reproduce one way a handler might combine cookies with `public`.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';

import { loadConfig } from '../config/index.js';
import {
  API_DEFAULT_CACHE_CONTROL,
  clearSessionCookies,
  COOKIE_RESPONSE_CACHE_CONTROL,
  responseCachingHook,
  setSessionCookies,
} from './session-cookies.js';

const config = loadConfig({
  NEXUS_SECRET_KEY: 'synthetic-secret-key-0123456789abcdef',
  FERRUM_ADMIN_JWT_SECRET: 'synthetic-admin-secret-0123456789abcdef',
  NEXUS_LOG_LEVEL: 'silent',
});

const material = { token: 'synthetic-session-value', csrfToken: 'synthetic-csrf-value' };
const PUBLIC = 'public, max-age=60';
const ETAG = '"synthetic-etag"';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  // Same order as `buildServer`: the cookie plugin's own `onSend` writer first.
  await app.register(cookie);
  app.addHook('onSend', async (request, reply, payload) => {
    return responseCachingHook(request, reply, payload);
  });

  // Cookies first, then a public directive, then a conditional 304: the shape
  // a sliding refresh followed by a cacheable handler produces.
  app.get('/api/public-with-session', async (request, reply) => {
    setSessionCookies(reply, config, material);
    reply.header('cache-control', PUBLIC);
    reply.header('etag', ETAG);
    if (request.headers['if-none-match'] === ETAG) {
      return reply.status(304).send();
    }
    return { ok: true };
  });
  app.get('/api/error-with-session', async (_request, reply) => {
    setSessionCookies(reply, config, material);
    reply.header('cache-control', PUBLIC);
    throw new Error('Synthetic failure');
  });
  app.post('/api/signed-out', async (_request, reply) => {
    clearSessionCookies(reply, config);
    reply.header('cache-control', PUBLIC);
    return { ok: true };
  });
  // Any cookie counts, not only the session pair, and an existing Vary is kept.
  app.get('/api/other-cookie', async (_request, reply) => {
    reply.setCookie('synthetic', 'value', { path: '/' });
    reply.header('vary', 'Accept-Encoding');
    reply.header('cache-control', PUBLIC);
    return { ok: true };
  });
  app.get('/api/array-vary-cookie', async (_request, reply) => {
    reply.setCookie('synthetic', 'value', { path: '/' });
    reply.header('vary', ['Accept-Encoding', 'cookie']);
    return { ok: true };
  });
  app.get('/api/star-vary-cookie', async (_request, reply) => {
    reply.setCookie('synthetic', 'value', { path: '/' });
    reply.header('vary', '*');
    return { ok: true };
  });
  app.get('/api/public', async (_request, reply) => {
    reply.header('cache-control', PUBLIC);
    return { ok: true };
  });
  app.get('/api/plain', async () => ({ ok: true }));
  app.get('/asset.js', async (_request, reply) => reply.type('text/javascript').send('void 0;'));
  await app.ready();
  return app;
}

function assertUncacheable(response: LightMyRequestResponse, label: string): void {
  assert.ok(response.headers['set-cookie'] !== undefined, `${label}: the response sets cookies`);
  assert.equal(response.headers['cache-control'], COOKIE_RESPONSE_CACHE_CONTROL, label);
  assert.match(String(response.headers.vary ?? ''), /(^|,\s*)Cookie$/, label);
}

describe('responses that set cookies are never shared-cacheable', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await buildApp();
  });

  after(async () => {
    await app.close();
  });

  it('overrides a public directive on a 200 that re-issues the session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/public-with-session' });
    assert.equal(response.statusCode, 200);
    assertUncacheable(response, '200');
  });

  it('keeps the guarantee on the conditional 304', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/public-with-session',
      headers: { 'if-none-match': ETAG },
    });
    assert.equal(response.statusCode, 304);
    assertUncacheable(response, '304');
  });

  it('keeps the guarantee on an error response', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/error-with-session' });
    assert.equal(response.statusCode, 500);
    assertUncacheable(response, '500');
  });

  it('applies to clearing the pair and to any other cookie', async () => {
    assertUncacheable(await app.inject({ method: 'POST', url: '/api/signed-out' }), 'sign-out');
    const other = await app.inject({ method: 'GET', url: '/api/other-cookie' });
    assertUncacheable(other, 'other cookie');
    assert.equal(other.headers.vary, 'Accept-Encoding, Cookie');
  });

  it('preserves array-valued Vary headers that already include Cookie', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/array-vary-cookie' });

    assert.ok(response.headers['set-cookie'] !== undefined);
    assert.equal(response.headers['cache-control'], COOKIE_RESPONSE_CACHE_CONTROL);
    assert.deepEqual(response.headers.vary, ['Accept-Encoding', 'cookie']);
  });

  it('preserves Vary: * when making a cookie response uncacheable', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/star-vary-cookie' });

    assert.ok(response.headers['set-cookie'] !== undefined);
    assert.equal(response.headers['cache-control'], COOKIE_RESPONSE_CACHE_CONTROL);
    assert.equal(response.headers.vary, '*');
  });

  it('leaves cookie-free responses as their handlers set them', async () => {
    const cacheable = await app.inject({ method: 'GET', url: '/api/public' });
    assert.equal(cacheable.statusCode, 200);
    assert.equal(cacheable.headers['set-cookie'], undefined);
    assert.equal(cacheable.headers['cache-control'], PUBLIC);
    assert.equal(cacheable.headers.vary, undefined);

    const plain = await app.inject({ method: 'GET', url: '/api/plain' });
    assert.equal(plain.headers['cache-control'], API_DEFAULT_CACHE_CONTROL);

    const asset = await app.inject({ method: 'GET', url: '/asset.js' });
    assert.equal(asset.statusCode, 200);
    assert.equal(asset.headers['cache-control'], undefined, 'non-API responses keep their own');
  });
});
