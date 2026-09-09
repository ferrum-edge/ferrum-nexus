import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { FastifyInstance } from 'fastify';

import {
  CSRF_COOKIE,
  CSRF_HEADER,
  SESSION_COOKIE,
  type ApiErrorBody,
  type MeResponse,
} from '@ferrum-nexus/shared';

import { CSRF_EXEMPT_PATHS } from '../middleware/auth-plugin.js';
import { buildTestApp, TEST_PASSWORD, type TestApp, type TestSession } from './helpers.js';

const API_PREFIXES = ['/api', '/%61pi', '/a%70i', '/ap%69', '/%61%70%69'];
const SPA = '<!doctype html><title>Nexus test shell</title>';
const ASSET = 'console.log("Nexus public asset");\n';
const EXEMPT_POSTS = [
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/verify-email',
  '/api/auth/resend-verification',
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
];

interface SocketResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** Pass the request target verbatim; URL/fetch normalization would hide cases. */
function socketRequest(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  payload?: unknown,
): Promise<SocketResponse> {
  return new Promise((resolve, reject) => {
    const data = payload === undefined ? undefined : JSON.stringify(payload);
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path,
        agent: false,
        headers: {
          ...headers,
          ...(data === undefined
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': String(Buffer.byteLength(data)),
              }),
        },
      },
      (res) => {
        res.setEncoding('utf8');
        let body = '';
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('error', reject);
        res.on('end', () =>
          resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body }),
        );
      },
    );
    req.on('error', reject);
    req.setTimeout(5_000, () => req.destroy(new Error('socket request timed out')));
    req.end(data);
  });
}

function assertError(response: SocketResponse, status: number, code: string): void {
  assert.equal(response.statusCode, status, response.body);
  assert.equal((JSON.parse(response.body) as ApiErrorBody).error.code, code);
  assert.match(String(response.headers['content-type']), /^application\/json/);
  assert.equal(response.headers['cache-control'], 'no-store');
}

describe('API route security over a listening socket', () => {
  let harness: TestApp;
  let admin: TestSession;
  let client: TestSession;
  let webDist: string;
  let port: number;
  const mutations = new Map<string, { method: string; url: string }>();

  before(async () => {
    webDist = await mkdtemp(join(tmpdir(), 'nexus-api-routing-'));
    await writeFile(join(webDist, 'index.html'), SPA);
    await mkdir(join(webDist, 'assets'));
    await writeFile(join(webDist, 'assets', 'app-test.js'), ASSET);

    // Observe actual route registration through Fastify's initialization
    // channel, so new mutations join the sweep without a production test seam.
    const initialization = channel('fastify.initialization');
    const observe = (message: unknown): void => {
      const { fastify } = message as { fastify: FastifyInstance };
      fastify.addHook('onRoute', (route) => {
        for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
          if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
            mutations.set(`${method} ${route.url}`, { method, url: route.url });
          }
        }
      });
    };
    initialization.subscribe(observe);
    try {
      harness = await buildTestApp({
        env: { NEXUS_WEB_DIST: webDist },
        deps: { serveStatic: true },
      });
    } finally {
      initialization.unsubscribe(observe);
    }
    admin = await harness.registerUser({ display_name: 'Original admin' });
    client = await harness.registerUser({ display_name: 'Original client' });
    await harness.app.listen({ host: '127.0.0.1', port: 0 });
    const address = harness.app.server.address();
    assert.ok(address && typeof address !== 'string');
    port = address.port;
  });

  after(async () => {
    await harness?.close();
    if (webDist) await rm(webDist, { recursive: true, force: true });
  });

  async function snapshot(): Promise<unknown> {
    return {
      user: await harness.store.users.findById(admin.user.id),
      session: await harness.store.sessions.findByTokenHash(
        harness.app.nexus.crypto.hashToken(admin.sessionToken),
      ),
      settings: await harness.services.settings.getAdminSettings(),
      audit: await harness.auditRows(),
      outbox: await harness.outbox(),
      edgeRequests: [...harness.edge.requests],
    };
  }

  it('delivers public assets with HEAD, ranges and cache revalidation', async () => {
    const credentials: Record<string, string>[] = [{}, { cookie: admin.cookieHeader }];
    for (const headers of credentials) {
      const asset = await socketRequest(port, 'GET', '/assets/app-test.js?v=1', headers);
      assert.equal(asset.statusCode, 200);
      assert.equal(asset.body, ASSET);
      assert.match(String(asset.headers['content-type']), /javascript/);
      assert.equal(asset.headers['cache-control'], 'public, max-age=0');
      assert.equal(asset.headers['set-cookie'], undefined);
      assert.ok(asset.headers.etag);

      const head = await socketRequest(port, 'HEAD', '/assets/app-test.js', headers);
      assert.equal(head.statusCode, 200);
      assert.equal(head.body, '');
      assert.equal(head.headers['content-length'], String(Buffer.byteLength(ASSET)));
      assert.equal(head.headers.etag, asset.headers.etag);

      const cached = await socketRequest(port, 'GET', '/assets/app-test.js', {
        ...headers,
        'if-none-match': asset.headers.etag,
      });
      assert.equal(cached.statusCode, 304);
      assert.equal(cached.body, '');
      assert.equal(cached.headers['cache-control'], asset.headers['cache-control']);

      const range = await socketRequest(port, 'GET', '/assets/app-test.js', {
        ...headers,
        range: 'bytes=0-6',
      });
      assert.equal(range.statusCode, 206);
      assert.equal(range.body, ASSET.slice(0, 7));
      assert.equal(range.headers['content-range'], `bytes 0-6/${Buffer.byteLength(ASSET)}`);
    }
  });

  it('keeps noncanonical asset targets out of explicit static routes', async () => {
    // Nexus registers discovered files, not a static wildcard. These targets
    // must not be normalized into the asset by the plugin or SPA fallback.
    for (const path of [
      '/other/../assets/app-test.js',
      '/other/%2e%2e/assets/app-test.js',
      '/assets/./app-test.js',
      '/assets//app-test.js',
      '/assets%2fapp-test.js',
      '/assets%5capp-test.js',
      '/assets/%252e%252e/app-test.js',
      '/assets/missing.js',
      '/api/assets/app-test.js',
    ]) {
      assertError(await socketRequest(port, 'GET', path), 404, 'NOT_FOUND');
      const head = await socketRequest(port, 'HEAD', path);
      assert.equal(head.statusCode, 404, path);
      assert.equal(head.body, '', path);
      assert.equal(head.headers['cache-control'], 'no-store', path);
    }
    for (const path of ['/assets/%', '/assets/%GG', '/assets/%FF.js']) {
      assertError(await socketRequest(port, 'GET', path), 400, 'VALIDATION_FAILED');
    }
    for (const path of ['/', '/dashboard', '/assets/']) {
      const shell = await socketRequest(port, 'GET', path);
      assert.equal(shell.statusCode, 200, path);
      assert.equal(shell.body, SPA, path);
      assert.equal(shell.headers['cache-control'], 'no-cache', path);
    }
  });

  it('rejects missing and mismatched CSRF before a profile mutation can persist', async () => {
    const before = await snapshot();
    for (const prefix of API_PREFIXES) {
      for (const token of [undefined, 'wrong-token']) {
        const response = await socketRequest(
          port,
          'PATCH',
          `${prefix}/users/me?next=/api/auth/login`,
          { cookie: admin.cookieHeader, ...(token ? { [CSRF_HEADER]: token } : {}) },
          { display_name: 'Must not persist' },
        );
        assertError(response, 403, 'CSRF_MISMATCH');
        assert.deepEqual(await snapshot(), before);
      }
      const forged = await socketRequest(
        port,
        'PATCH',
        `${prefix}/users/me`,
        {
          cookie: `${SESSION_COOKIE}=${admin.sessionToken}; ${CSRF_COOKIE}=forged`,
          [CSRF_HEADER]: 'forged',
        },
        { display_name: 'Must not persist' },
      );
      assertError(forged, 403, 'CSRF_MISMATCH');
      assert.deepEqual(await snapshot(), before);
    }
  });

  it('covers every registered mutating API method and route before its handler', async () => {
    const protectedRoutes = [...mutations.values()].filter(
      ({ url }) => !EXEMPT_POSTS.includes(url) && url !== '/api' && url !== '/api/*',
    );
    assert.ok(protectedRoutes.length >= 33, 'the full application route inventory was captured');
    const before = await snapshot();
    for (const { method, url } of protectedRoutes) {
      assert.ok(url.startsWith('/api/'), `mutation outside the API scope: ${method} ${url}`);
      const path = url.replace(/:[^/]+/g, '00000000-0000-4000-8000-000000000001');
      for (const prefix of API_PREFIXES) {
        const response = await socketRequest(
          port,
          method,
          `${prefix}${path.slice(4)}?source=route-sweep`,
          { cookie: admin.cookieHeader },
          {},
        );
        assertError(response, 403, 'CSRF_MISMATCH');
      }
    }
    assert.deepEqual(await snapshot(), before, 'no audit, outbox, gateway or account writes');
  });

  it('preserves valid mutations and no-store reads for every accepted spelling', async () => {
    const paths = API_PREFIXES.map((prefix) => `${prefix}/users/me`);
    paths.push('/%61pi/%75sers/%6De');
    for (const [index, path] of paths.entries()) {
      const displayName = `Saved profile ${index}`;
      const response = await socketRequest(
        port,
        'PATCH',
        `${path}?returnTo=%2Fapi%2Fauth%2Flogin`,
        { cookie: admin.cookieHeader, [CSRF_HEADER]: admin.csrfToken },
        { display_name: displayName },
      );
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal((await harness.store.users.findById(admin.user.id))?.display_name, displayName);
      const read = await socketRequest(port, 'GET', '/%61pi/auth/me?ignored=%GG', {
        cookie: admin.cookieHeader,
      });
      assert.equal(read.statusCode, 200, read.body);
      assert.equal(read.headers['cache-control'], 'no-store');
      const me = JSON.parse(read.body) as MeResponse;
      assert.equal(me.user.display_name, displayName);
      assert.equal(me.csrf_token, admin.csrfToken);
    }
    for (const prefix of API_PREFIXES) {
      for (const method of ['GET', 'HEAD']) {
        const response = await socketRequest(port, method, `${prefix}/auth/me`, {
          cookie: admin.cookieHeader,
        });
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.headers['cache-control'], 'no-store');
      }
    }
  });

  it('preserves all seven pre-session exemptions, even with a session', async () => {
    assert.deepEqual([...CSRF_EXEMPT_PATHS].sort(), [...EXEMPT_POSTS, '/api/auth/captcha'].sort());
    for (const prefix of API_PREFIXES) {
      for (const path of EXEMPT_POSTS) {
        // Invalid bodies must reach route validation, including while signed
        // in. An exemption based on the raw spelling would fail with CSRF.
        const response = await socketRequest(
          port,
          'POST',
          `${prefix}${path.slice(4)}?from=portal`,
          { cookie: admin.cookieHeader },
          {},
        );
        assertError(response, 400, 'VALIDATION_FAILED');
      }
      const captcha = await socketRequest(port, 'GET', `${prefix}/auth/captcha`);
      assert.equal(captcha.statusCode, 200, captcha.body);
      assert.equal(captcha.headers['cache-control'], 'no-store');
      const login = await socketRequest(
        port,
        'POST',
        `${prefix}/auth/login`,
        {},
        {
          email: client.user.email,
          password: TEST_PASSWORD,
        },
      );
      assert.equal(login.statusCode, 200, login.body);
      assert.equal(login.headers['cache-control'], 'no-store');
    }
  });

  it('retains anonymous authentication failures and authenticated role checks', async () => {
    const before = await snapshot();
    for (const prefix of API_PREFIXES) {
      assertError(
        await socketRequest(port, 'PATCH', `${prefix}/users/me`, {}, { display_name: 'Denied' }),
        401,
        'UNAUTHORIZED',
      );
      assertError(
        await socketRequest(
          port,
          'PUT',
          `${prefix}/admin/settings`,
          { cookie: client.cookieHeader, [CSRF_HEADER]: client.csrfToken },
          { branding: { portal_name: 'Denied' } },
        ),
        403,
        'FORBIDDEN',
      );
    }
    assert.deepEqual(await snapshot(), before);
  });

  it('answers API misses with JSON and preserves the SPA boundary', async () => {
    const before = await snapshot();
    for (const prefix of API_PREFIXES) {
      for (const suffix of ['', '/', '/does-not-exist', '/auth/login/extra', '/missing.js']) {
        const path = `${prefix}${suffix}?ignored=/dashboard`;
        assertError(await socketRequest(port, 'GET', path), 404, 'NOT_FOUND');
        const head = await socketRequest(port, 'HEAD', path, { cookie: admin.cookieHeader });
        assert.equal(head.statusCode, 404);
        assert.equal(head.body, '');
        assert.equal(head.headers['cache-control'], 'no-store');
        assertError(
          await socketRequest(port, 'OPTIONS', path, { cookie: admin.cookieHeader }),
          404,
          'NOT_FOUND',
        );
        assertError(
          await socketRequest(port, 'POST', path, { cookie: admin.cookieHeader }, {}),
          403,
          'CSRF_MISMATCH',
        );
        assertError(
          await socketRequest(
            port,
            'POST',
            path,
            { cookie: admin.cookieHeader, [CSRF_HEADER]: admin.csrfToken },
            {},
          ),
          404,
          'NOT_FOUND',
        );
      }
    }
    // None of these are API route identities in the configured router. Do
    // not decode separators twice, fold case or resolve dot segments here.
    for (const path of [
      '/dashboard?next=/api/auth/me',
      '/apix',
      '/%61pix/users/me',
      '/API/users/me',
      '/%41PI/users/me',
      '/%2561pi/users/me',
      '/api%2Fusers/me',
      '/api%3F/users/me',
      '/other/../api/users/me',
    ]) {
      const response = await socketRequest(port, 'GET', path, { cookie: admin.cookieHeader });
      assert.equal(response.statusCode, 200, path);
      assert.equal(response.body, SPA, path);
      assert.equal(response.headers['cache-control'], 'no-cache', path);
      assertError(
        await socketRequest(port, 'PATCH', path, { cookie: admin.cookieHeader }),
        404,
        'NOT_FOUND',
      );
    }
    assertError(await socketRequest(port, 'GET', '/missing.js'), 404, 'NOT_FOUND');
    assert.deepEqual(await snapshot(), before);
  });

  it('rejects malformed paths before API or SPA handling with any credentials', async () => {
    const before = await snapshot();
    const credentials: Record<string, string>[] = [
      {},
      { cookie: admin.cookieHeader },
      { cookie: admin.cookieHeader, [CSRF_HEADER]: admin.csrfToken },
    ];
    // Router errors must fail closed independently of session/CSRF hooks.
    // Include anonymous reads and authorized mutations so neither an auth
    // rejection nor missing CSRF can mask a routing regression.
    for (const path of ['/%', '/api/%GG', '/%61pi/%', '/api/%C0%AF', '/api/users/%FF']) {
      for (const method of ['GET', 'PATCH', 'DELETE']) {
        for (const headers of credentials) {
          const response = await socketRequest(port, method, path, headers);
          assertError(response, 400, 'VALIDATION_FAILED');
          assert.equal(response.headers['set-cookie'], undefined);
          assert.equal(response.body.includes(SPA), false);
        }
      }
    }
    assert.deepEqual(await snapshot(), before);
  });
});
