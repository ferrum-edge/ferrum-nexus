/**
 * What a **real gateway** permits, against the **packaged portal** (issue #285).
 *
 * Every other suite in this repository asks Nexus whether it believes a
 * decision was applied. These ask Ferrum Edge, by sending requests to the
 * listener a client uses and checking whether they reached the deterministic
 * upstream. The Admin API is never consulted for an assertion — only for the
 * one destructive step that simulates an operator deleting a proxy.
 *
 * The stack is the one an operator deploys: the production container image,
 * PostgreSQL, a pinned Edge release, real SMTP. Nothing is stubbed, and the
 * portal has no idea it is under test.
 *
 * Run it with `./e2e/run.sh`; see `e2e/README.md`.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';

import {
  authHeadersFor,
  grantAccess,
  issueCredential,
  publishApi,
  type IssuedCredential,
  type PublishedApi,
} from './fixtures.js';
import {
  callGateway,
  clearMail,
  portal,
  portalRaw,
  reachedUpstream,
  registerVerifiedUser,
  signIn,
  waitFor,
  waitForStack,
  type Session,
} from './harness.js';

const run = promisify(execFile);

/** Unique per run, so a re-run against a warm stack does not collide. */
const RUN = Date.now().toString(36);

/** Compose service control, for the restart and restore cases. */
const COMPOSE = (process.env.E2E_COMPOSE ?? 'docker compose').split(' ');

async function compose(...args: string[]): Promise<void> {
  const [command, ...prefix] = COMPOSE;
  if (!command) throw new Error('E2E_COMPOSE is empty');
  await run(command, [...prefix, ...args], {
    cwd: process.env.E2E_PROJECT_DIR ?? process.cwd(),
    env: process.env,
  });
}

describe('packaged Nexus against a real Ferrum Edge', { concurrency: false }, () => {
  let provider: Session;
  let outsider: Session;
  let clients = 0;

  /**
   * A fresh verified client per case.
   *
   * Not an optimisation dodge: Edge caps a consumer at two live credentials of
   * each type, so a suite that issued one per case from a single account would
   * be exhausting a real gateway limit rather than testing anything. A portal
   * has many clients; the suite has many clients.
   */
  async function newClient(): Promise<Session> {
    clients += 1;
    return registerVerifiedUser(`client-${RUN}-${clients}@example.test`, 'client');
  }

  before(async () => {
    await waitForStack();
    await clearMail();

    // The bootstrap account is the provider. Every other account goes through
    // the real registration and verification flow, mail included.
    const bootstrapEmail = `provider-${RUN}@example.test`;
    provider = await registerVerifiedUser(bootstrapEmail, 'provider', { bootstrap: true });
    // The suite needs the portal's *first* account, because it turns the
    // verification policy on and publishes APIs. Running it against a stack
    // somebody has already registered into fails here, with the reason, rather
    // than as an unexplained `403` four calls later.
    assert.equal(
      provider.role,
      'super_admin',
      'the acceptance suite needs a freshly created stack — run `./e2e/run.sh`, ' +
        'or bring the current one down with `docker compose down -v` first',
    );

    // Verification is a portal policy an operator turns on, so the suite turns
    // it on before the accounts that have to go through it are created.
    await portal('PUT', '/api/admin/settings', {
      session: provider,
      body: { registration: { require_email_verification: true } },
      expect: 200,
    });

    outsider = await registerVerifiedUser(`outsider-${RUN}@example.test`, 'client');
  });

  after(async () => {
    await clearMail();
  });

  /* ── The authentication matrix ────────────────────────────────────────── */

  for (const flavour of [
    // `forwardsCredential` is observed behaviour, pinned rather than wished
    // for. Edge hides the API key and the basic-auth header from the backend;
    // it forwards the bearer token, because a backend commonly wants the
    // claims. That asymmetry is worth knowing about — a provider's upstream
    // does see its clients' live JWTs — so the suite states it rather than
    // asserting a uniform rule that is not true.
    { plugin: 'key_auth', credential: 'keyauth', forwardsCredential: false },
    { plugin: 'basic_auth', credential: 'basicauth', forwardsCredential: false },
    { plugin: 'jwt_auth', credential: 'jwt', forwardsCredential: true },
  ] as const) {
    it(`denies then allows a ${flavour.plugin} API at the real gateway`, async () => {
      const client = await newClient();
      const api = await publishApi(provider, {
        name: `E2E ${flavour.plugin} ${RUN}`,
        slug: `e2e-${flavour.plugin.replace('_', '-')}-${RUN}`,
        authPlugin: flavour.plugin,
      });
      await waitFor(`${api.listen_path} to be served`, async () => {
        const response = await callGateway(`${api.listen_path}/invoices`);
        return response.status !== 404;
      });

      // Unauthenticated: the gateway refuses before the backend is involved.
      const anonymous = await callGateway(`${api.listen_path}/invoices`);
      assert.equal(anonymous.status, 401, 'an unauthenticated call is refused');
      assert.equal(reachedUpstream(anonymous), false, 'and never reaches the backend');

      await grantAccess(client, provider, api.id);
      const credential = await issueCredential(client, flavour.credential);

      const approved = await callGateway(`${api.listen_path}/invoices`, {
        headers: authHeadersFor(credential, flavour.credential),
      });
      // Read once: a `Response` body is a stream, and passing `await
      // response.text()` as an assertion message consumes it before the
      // assertion that needs it can parse it.
      const approvedBody = await approved.text();
      assert.equal(approved.status, 200, approvedBody);
      assert.ok(reachedUpstream(approved), 'an approved call reaches the real upstream');

      // What the backend was actually given. The API key and the basic-auth
      // header are stripped at the gateway; the bearer token is not. Pinning
      // both halves is the point: a change in either direction is a change to
      // what a provider's upstream can see of its clients' credentials.
      const echoed = JSON.parse(approvedBody) as { headers: Record<string, string> };
      const names = new Set(Object.keys(echoed.headers).map((name) => name.toLowerCase()));
      assert.ok(!names.has('x-api-key'), 'the API key never reaches the backend');
      assert.equal(
        names.has('authorization'),
        flavour.forwardsCredential,
        flavour.forwardsCredential
          ? 'a bearer token is forwarded to the backend, which is Edge’s jwt_auth default'
          : 'the Authorization header is stripped at the gateway',
      );
    });
  }

  /* ── Enforcement modes ────────────────────────────────────────────────── */

  it('serves only the declared operations of a `routes` API', async () => {
    const client = await newClient();
    const api = await publishApi(provider, {
      name: `E2E routes ${RUN}`,
      slug: `e2e-routes-${RUN}`,
      authPlugin: 'key_auth',
      enforcement: 'routes',
      paths: ['/invoices'],
    });
    await grantAccess(client, provider, api.id);
    const credential = await issueCredential(client, 'keyauth');
    const headers = authHeadersFor(credential, 'keyauth');

    await waitFor(`${api.listen_path} to be served`, async () => {
      const response = await callGateway(`${api.listen_path}/invoices`, { headers });
      return response.status === 200;
    });

    const declared = await callGateway(`${api.listen_path}/invoices`, { headers });
    assert.equal(declared.status, 200);
    assert.ok(reachedUpstream(declared));

    // The generated validator is what makes this different from `docs_only`.
    const undeclared = await callGateway(`${api.listen_path}/not-in-the-document`, { headers });
    assert.ok(undeclared.status >= 400, `expected a refusal, got ${undeclared.status}`);
    assert.equal(reachedUpstream(undeclared), false, 'an undeclared path never reaches upstream');
  });

  it('forwards an undeclared path on a `docs_only` API', async () => {
    const client = await newClient();
    const api = await publishApi(provider, {
      name: `E2E docs only ${RUN}`,
      slug: `e2e-docsonly-${RUN}`,
      authPlugin: 'key_auth',
      paths: ['/invoices'],
    });
    await grantAccess(client, provider, api.id);
    const credential = await issueCredential(client, 'keyauth');
    const headers = authHeadersFor(credential, 'keyauth');
    await waitFor(`${api.listen_path} to be served`, async () => {
      const response = await callGateway(`${api.listen_path}/invoices`, { headers });
      return response.status === 200;
    });

    // `docs_only` means the document is catalog metadata: the proxy forwards
    // whatever it is given. Asserting it keeps the two modes honestly distinct.
    const undeclared = await callGateway(`${api.listen_path}/anything`, { headers });
    assert.equal(undeclared.status, 200);
    assert.ok(reachedUpstream(undeclared));
  });

  /* ── Revocation and rotation, at the gateway ──────────────────────────── */

  it('stops an approved client the moment access is revoked', async () => {
    const client = await newClient();
    const api = await publishApi(provider, {
      name: `E2E revoke ${RUN}`,
      slug: `e2e-revoke-${RUN}`,
      authPlugin: 'key_auth',
    });
    const { grantId } = await grantAccess(client, provider, api.id);
    const credential = await issueCredential(client, 'keyauth');
    const headers = authHeadersFor(credential, 'keyauth');

    await waitFor('the approved call to succeed', async () => {
      const response = await callGateway(`${api.listen_path}/invoices`, { headers });
      return response.status === 200;
    });

    await portal('POST', `/api/grants/${grantId}/revoke`, {
      session: provider,
      body: { reason: 'End-to-end revocation' },
      expect: 200,
    });

    await waitFor('the gateway to refuse the revoked client', async () => {
      const response = await callGateway(`${api.listen_path}/invoices`, { headers });
      return response.status === 403;
    });

    // The credential still authenticates — it is the *authorization* that went.
    // Conflating the two is how a portal ends up revoking the wrong thing.
    const refused = await callGateway(`${api.listen_path}/invoices`, { headers });
    assert.equal(refused.status, 403);
    assert.equal(reachedUpstream(refused), false);
  });

  it('keeps the retiring credential working until the rotation is settled', async () => {
    const client = await newClient();
    const api = await publishApi(provider, {
      name: `E2E rotate ${RUN}`,
      slug: `e2e-rotate-${RUN}`,
      authPlugin: 'key_auth',
    });
    await grantAccess(client, provider, api.id);
    const original = await issueCredential(client, 'keyauth');
    const originalHeaders = authHeadersFor(original, 'keyauth');
    await waitFor('the first credential to work', async () => {
      const response = await callGateway(`${api.listen_path}/invoices`, {
        headers: originalHeaders,
      });
      return response.status === 200;
    });

    const rotated = await portal<{
      credential: { id: string };
      consumer_username: string;
      secret: Record<string, string>;
    }>('POST', `/api/credentials/${original.id}/rotate`, {
      session: client,
      body: {},
      expect: 200,
    });
    const replacement: IssuedCredential = {
      id: rotated.credential.id,
      consumerUsername: rotated.consumer_username,
      secret: rotated.secret,
    };

    // Append-then-delete: the new key works immediately…
    await waitFor('the replacement credential to work', async () => {
      const response = await callGateway(`${api.listen_path}/invoices`, {
        headers: authHeadersFor(replacement, 'keyauth'),
      });
      return response.status === 200;
    });
    const withNew = await callGateway(`${api.listen_path}/invoices`, {
      headers: authHeadersFor(replacement, 'keyauth'),
    });
    assert.ok(reachedUpstream(withNew));

    // …and the retired one is gone from the gateway, which is the documented
    // end state of a rotation rather than an overlap that never closes.
    await waitFor('the retired credential to stop working', async () => {
      const response = await callGateway(`${api.listen_path}/invoices`, {
        headers: originalHeaders,
      });
      return response.status === 401;
    });
  });

  /* ── CORS, from the browser's point of view ───────────────────────────── */

  it('answers a browser preflight with the configured policy', async () => {
    const origin = 'https://app.example.test';
    const client = await newClient();
    const api = await publishApi(provider, {
      name: `E2E cors ${RUN}`,
      slug: `e2e-cors-${RUN}`,
      authPlugin: 'key_auth',
      cors: { allowed_origins: [origin], allow_credentials: false },
    });
    await grantAccess(client, provider, api.id);
    const credential = await issueCredential(client, 'keyauth');
    await waitFor('the CORS API to be served', async () => {
      const response = await callGateway(`${api.listen_path}/invoices`, {
        headers: authHeadersFor(credential, 'keyauth'),
      });
      return response.status === 200;
    });

    const preflight = await callGateway(`${api.listen_path}/invoices`, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'x-api-key',
      },
    });
    assert.ok(preflight.status < 400, `preflight answered ${preflight.status}`);
    assert.equal(
      preflight.headers.get('access-control-allow-origin'),
      origin,
      'the gateway answers the preflight itself, before authentication',
    );

    const disallowed = await callGateway(`${api.listen_path}/invoices`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://somewhere-else.example.test',
        'access-control-request-method': 'GET',
      },
    });
    assert.notEqual(
      disallowed.headers.get('access-control-allow-origin'),
      'https://somewhere-else.example.test',
      'an origin outside the policy is not echoed back',
    );
  });

  /* ── Restarts ─────────────────────────────────────────────────────────── */

  it('keeps serving an approved client across a restart of both services', async () => {
    const client = await newClient();
    const api = await publishApi(provider, {
      name: `E2E restart ${RUN}`,
      slug: `e2e-restart-${RUN}`,
      authPlugin: 'key_auth',
    });
    await grantAccess(client, provider, api.id);
    const credential = await issueCredential(client, 'keyauth');
    const headers = authHeadersFor(credential, 'keyauth');
    await waitFor('the call to succeed before the restart', async () => {
      const response = await callGateway(`${api.listen_path}/invoices`, { headers });
      return response.status === 200;
    });

    await compose('restart', 'ferrum-edge', 'nexus');
    await waitForStack();

    // Persisted state, not in-memory state: the gateway rebuilt its runtime
    // from its own database and the portal reconnected to the same Postgres.
    await waitFor('the call to succeed after the restart', async () => {
      const response = await callGateway(`${api.listen_path}/invoices`, { headers });
      return response.status === 200;
    });
    const after = await callGateway(`${api.listen_path}/invoices`, { headers });
    assert.ok(reachedUpstream(after));

    const listed = await portal<{ items: { id: string }[] }>('GET', '/api/apis?limit=100', {
      session: provider,
      expect: 200,
    });
    assert.ok(
      listed.items.some((item) => item.id === api.id),
      'and the catalog survived it',
    );
  });

  /* ── Restoring a deployment the gateway lost (issue #284) ─────────────── */

  it('restores an API whose proxy an operator deleted, and refuses to lie when it cannot', async () => {
    const client = await newClient();
    const api = await publishApi(provider, {
      name: `E2E restore ${RUN}`,
      slug: `e2e-restore-${RUN}`,
      authPlugin: 'key_auth',
    });
    await grantAccess(client, provider, api.id);
    const credential = await issueCredential(client, 'keyauth');
    const headers = authHeadersFor(credential, 'keyauth');
    await waitFor('the call to succeed before the proxy is deleted', async () => {
      const response = await callGateway(`${api.listen_path}/invoices`, { headers });
      return response.status === 200;
    });

    // The only Admin API call in the suite, and it is the *destructive* step
    // being simulated: an operator deleting one proxy and nothing else. The
    // consumer, its ACL group and its credential all stay.
    const stored = await portal<{ api: { ferrum_proxy_id: string | null } }>(
      'GET',
      `/api/apis/${api.id}`,
      { session: provider, expect: 200 },
    );
    const proxyId = stored.api.ferrum_proxy_id;
    assert.ok(proxyId, 'the API has a proxy to delete');
    await deleteProxyOnGateway(proxyId);

    await waitFor('the public path to stop being served', async () => {
      const response = await callGateway(`${api.listen_path}/invoices`, { headers });
      return response.status === 404;
    });

    // The portal notices, and says so rather than reporting a clean run.
    await portal('POST', '/api/admin/gateway/reconcile', {
      session: provider,
      body: {},
      expect: 200,
    });
    const repaired = await portal<{ report: { awaiting_restore: number } }>(
      'POST',
      '/api/admin/gateway/repair',
      { session: provider, body: { all: true, reason: 'e2e' }, expect: 200 },
    );
    assert.ok(repaired.report !== undefined);
    const flagged = await portal<{ api: { gateway_state: string } }>('GET', `/api/apis/${api.id}`, {
      session: provider,
      expect: 200,
    });
    assert.equal(flagged.api.gateway_state, 'repair_required');

    const restored = await portal<{ api: { gateway_state: string }; proxy_id: string }>(
      'POST',
      `/api/apis/${api.id}/restore-gateway`,
      { session: provider, body: {}, expect: 200 },
    );
    assert.equal(restored.api.gateway_state, 'deployed');
    assert.notEqual(restored.proxy_id, proxyId, 'a new proxy was built');

    // The existing client, with the credential it already had, at the same
    // address. That is what "non-destructive" has to mean.
    await waitFor('the original credential to work again', async () => {
      const response = await callGateway(`${api.listen_path}/invoices`, { headers });
      return response.status === 200;
    });
    const back = await callGateway(`${api.listen_path}/invoices`, { headers });
    assert.ok(reachedUpstream(back));

    // And an unapproved account is still refused — restoration is not amnesty.
    const outsiderCredential = await issueCredential(outsider, 'keyauth');
    const denied = await callGateway(`${api.listen_path}/invoices`, {
      headers: authHeadersFor(outsiderCredential, 'keyauth'),
    });
    assert.equal(denied.status, 403);
    assert.equal(reachedUpstream(denied), false);

    // A second restore has nothing to do and says so, rather than building a
    // duplicate proxy beside the live one.
    const again = await portalRaw('POST', `/api/apis/${api.id}/restore-gateway`, {
      session: provider,
      body: {},
    });
    assert.equal(again.status, 409, await again.text());
  });
});

/**
 * Delete one proxy through Edge's Admin API — the operator action the restore
 * case exists to recover from.
 *
 * It mints its own admin token from the shared secret rather than borrowing
 * one from the portal, because the portal is the thing under test and must not
 * be asked to help break itself.
 */
async function deleteProxyOnGateway(proxyId: string): Promise<void> {
  const { createHmac, randomUUID } = await import('node:crypto');
  const secret = process.env.FERRUM_ADMIN_JWT_SECRET;
  const issuer = process.env.FERRUM_ADMIN_JWT_ISSUER ?? 'ferrum-edge';
  const namespace = process.env.FERRUM_NAMESPACE ?? 'nexus';
  const adminUrl = process.env.E2E_ADMIN_URL ?? 'http://127.0.0.1:9000';
  if (!secret) throw new Error('FERRUM_ADMIN_JWT_SECRET is required to simulate the deletion');

  const encode = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  // Every claim Edge requires of an admin token: the role, the namespace it
  // authorizes, and the standard registered set. A token missing `ns`, `nbf`
  // or `jti` authenticates as nobody.
  const body = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    sub: 'e2e-operator',
    role: 'admin',
    ns: namespace,
    iss: issuer,
    iat: now,
    nbf: now,
    exp: now + 300,
    jti: randomUUID(),
  })}`;
  const token = `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;

  const response = await fetch(`${adminUrl}/proxies/${encodeURIComponent(proxyId)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}`, 'X-Ferrum-Namespace': namespace },
  });
  if (response.status >= 400 && response.status !== 404) {
    throw new Error(`Deleting proxy ${proxyId} answered ${response.status}`);
  }
}
