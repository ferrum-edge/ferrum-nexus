import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const portal = 'http://nexus:8787';
const gateway = 'http://ferrum-edge:8000';
const control = 'http://10.203.0.10:9101';
const password = 'correct-horse-battery-staple';
let cookie = '';
let csrf = '';

async function call(method, path, body, expected = 200) {
  const response = await fetch(portal + path, {
    method,
    headers: {
      'content-type': 'application/json',
      cookie,
      'x-nexus-csrf': csrf,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, expected, `Nexus ${method} ${path} status`);
  const result = await response.json();
  const jar = response.headers.getSetCookie().map((entry) => entry.split(';')[0]);
  if (jar.length) {
    cookie = jar.join('; ');
    const csrfCookie = jar.find((entry) => entry.startsWith('nexus_csrf='));
    csrf = csrfCookie?.slice('nexus_csrf='.length) ?? csrf;
  }
  return result;
}

const deadline = Date.now() + 120_000;
for (;;) {
  try {
    const health = await call('GET', '/api/health');
    if (health.status === 'ok') break;
  } catch {
    // Startup only; capability failures eventually fail this bounded wait.
  }
  assert.ok(Date.now() < deadline, 'packaged public-only pairing never became ready');
  await delay(500);
}
const founder = await call(
  'POST',
  '/api/auth/register',
  {
    email: 'operator@fixture.test',
    display_name: 'Fixture operator',
    role: 'provider',
    password,
    bootstrap_token: process.env.NEXUS_BOOTSTRAP_TOKEN,
  },
  201,
);
assert.equal(founder.user.role, 'super_admin', 'fixture must start from an empty Nexus database');
await call('POST', '/api/auth/login', { email: 'operator@fixture.test', password });
await call('PUT', '/api/admin/settings', { registration: { require_email_verification: false } });
await call(
  'POST',
  '/api/auth/register',
  {
    email: 'provider@fixture.test',
    display_name: 'Fixture provider',
    role: 'provider',
    password,
  },
  201,
);
await call('POST', '/api/auth/login', { email: 'provider@fixture.test', password });
const { api } = await call(
  'POST',
  '/api/apis',
  {
    name: 'Controlled DNS rebinding',
    slug: 'controlled-rebinding',
    auth_plugin: 'key_auth',
    requestable: false,
    visibility: 'public',
    spec_enforcement: 'docs_only',
    spec: JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Controlled', version: '1' },
      servers: [{ url: 'http://rebind.fixture.test:9100' }],
      paths: { '/marker': { get: { responses: { 200: { description: 'OK' } } } } },
    }),
  },
  201,
);
const issued = await call('POST', '/api/credentials', { credential_type: 'keyauth' }, 201);
const key = issued.secret?.key;
assert.equal(typeof key, 'string', 'show-once key was not issued');
async function traffic() {
  return fetch(`${gateway}/nexus/${api.slug}/marker`, {
    headers: { 'x-api-key': key, connection: 'close' },
    signal: AbortSignal.timeout(10_000),
  });
}
let served = false;
for (let attempt = 0; attempt < 60; attempt += 1) {
  const response = await traffic();
  const body = await response.text();
  if (response.status === 200 && body === 'controlled-public') {
    served = true;
    break;
  }
  await delay(500);
}
assert.ok(served, 'initial public-resolving hostname must carry successful gateway traffic');
const rebound = await fetch(control + '/rebind', {
  method: 'POST',
  signal: AbortSignal.timeout(5_000),
});
assert.equal(rebound.status, 200, 'controlled DNS switch must be acknowledged');
await rebound.json();
await delay(3_000); // Exceeds the one-second positive and stale DNS TTLs.
let observedPrivateAnswer = false;
for (let attempt = 0; attempt < 20; attempt += 1) {
  const response = await traffic();
  const body = await response.text();
  assert.ok(!body.includes('PRIVATE-CANARY'), 'gateway reached the private canary');
  const statsResponse = await fetch(control + '/stats', { signal: AbortSignal.timeout(5_000) });
  assert.equal(statsResponse.status, 200, 'controlled canary counters must remain readable');
  const stats = await statsResponse.json();
  assert.equal(stats.privateRequests, 0, 'private canary must receive no request');
  if (stats.edgePrivateAnswers > 0) {
    assert.ok(response.status >= 400, 'fresh private resolution must refuse the connection');
    observedPrivateAnswer = true;
  }
  await delay(500);
}
assert.ok(observedPrivateAnswer, 'Edge must refresh DNS to the controlled private answer');
console.log('Packaged singleton public-only DNS-rebinding fixture passed');
