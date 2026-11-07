/**
 * No response that carries a user carries its password verifier.
 *
 * `users.password_hash` is stripped by one projection, `toPublicUser` in
 * `auth/service.ts`, and nothing downstream backs it up: routes declare no
 * Fastify response schema, and a rest-spread result is exempt from
 * TypeScript's excess-property check, so a copy that forgot a field would
 * still type-check. These cases drive every route that answers with a `User`
 * and scan the whole JSON body — key and stored value — so a route that ever
 * serialises the record itself, or a second projection that drifts, fails here.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { LightMyRequestResponse } from 'fastify';

import type { User } from '@ferrum-nexus/shared';

import { toPublicUser } from '../auth/service.js';
import type { UserRecord } from '../db/store.js';
import {
  TEST_BOOTSTRAP_TOKEN,
  TEST_PASSWORD,
  buildTestApp,
  type TestApp,
  type TestSession,
} from './helpers.js';

/** Every object key anywhere in `value`. */
function keysOf(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) keysOf(item, into);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      keysOf(child, into);
    }
  }
  return into;
}

describe('user-bearing responses never carry password_hash', () => {
  let harness: TestApp;
  let superAdmin: TestSession;
  let client: TestSession;

  /** The stored verifiers of every account, so a body can be checked for any of them. */
  async function storedHashes(): Promise<string[]> {
    const page = await harness.store.users.list({}, { limit: 100, offset: 0 });
    return page.items.map((user) => user.password_hash);
  }

  async function assertNoPasswordHash(
    route: string,
    response: LightMyRequestResponse,
    status: number,
  ): Promise<void> {
    assert.equal(response.statusCode, status, `${route}: ${response.body}`);
    const body: unknown = response.json();
    assert.ok(!keysOf(body).has('password_hash'), `${route} returned a password_hash key`);
    for (const hash of await storedHashes()) {
      assert.ok(!response.body.includes(hash), `${route} returned a stored password verifier`);
    }
  }

  before(async () => {
    harness = await buildTestApp();
    superAdmin = await harness.registerUser({ email: 'projection-super@example.test' });
    assert.equal(superAdmin.user.role, 'super_admin');
    client = await harness.registerUser({ email: 'projection-client@example.test' });
  });

  after(async () => {
    await harness.close();
  });

  it('strips the hash and keeps every other field (unit)', () => {
    const record: UserRecord = {
      ...client.user,
      password_hash: 'scrypt:16384:8:1:c2FsdA:aGFzaA',
    };
    const projected = toPublicUser(record);
    assert.ok(!('password_hash' in projected));
    assert.deepEqual(projected, client.user satisfies User);
  });

  it('POST /api/auth/register', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'projection-register@example.test',
        password: TEST_PASSWORD,
        display_name: 'Projection Register',
        role: 'client',
        bootstrap_token: TEST_BOOTSTRAP_TOKEN,
      },
    });
    await assertNoPasswordHash('POST /api/auth/register', response, 201);
  });

  it('POST /api/auth/login', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'projection-client@example.test', password: TEST_PASSWORD },
    });
    await assertNoPasswordHash('POST /api/auth/login', response, 200);
  });

  it('GET /api/auth/me', async () => {
    const response = await harness.authed(client, { method: 'GET', url: '/api/auth/me' });
    await assertNoPasswordHash('GET /api/auth/me', response, 200);
  });

  it('GET and PATCH /api/users/me', async () => {
    const read = await harness.authed(client, { method: 'GET', url: '/api/users/me' });
    await assertNoPasswordHash('GET /api/users/me', read, 200);
    const patched = await harness.authed(client, {
      method: 'PATCH',
      url: '/api/users/me',
      payload: { display_name: 'Projection Client' },
    });
    await assertNoPasswordHash('PATCH /api/users/me', patched, 200);
  });

  it('GET /api/users and GET/PATCH /api/users/:id', async () => {
    const list = await harness.authed(superAdmin, { method: 'GET', url: '/api/users' });
    await assertNoPasswordHash('GET /api/users', list, 200);
    const one = await harness.authed(superAdmin, {
      method: 'GET',
      url: `/api/users/${client.user.id}`,
    });
    await assertNoPasswordHash('GET /api/users/:id', one, 200);
    const patched = await harness.authed(superAdmin, {
      method: 'PATCH',
      url: `/api/users/${client.user.id}`,
      payload: { display_name: 'Renamed By Admin' },
    });
    await assertNoPasswordHash('PATCH /api/users/:id', patched, 200);
  });

  it('POST /api/admin/god/disable-user', async () => {
    const target = await harness.registerUser({ email: 'projection-disable@example.test' });
    const response = await harness.authed(superAdmin, {
      method: 'POST',
      url: '/api/admin/god/disable-user',
      payload: { user_id: target.user.id, reason: 'Projection check.' },
    });
    await assertNoPasswordHash('POST /api/admin/god/disable-user', response, 200);
  });
});
