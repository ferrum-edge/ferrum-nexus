/**
 * What a **real gateway** permits, against the **packaged portal** (issue #285).
 *
 * Every other suite in this repository asks Nexus whether it believes a
 * decision was applied. These ask Ferrum Edge, by sending requests to the
 * listener a client uses and checking whether they reached the deterministic
 * upstream. Deployment protocol tests additionally compare complete owner
 * snapshots; authenticated traffic remains the proof of application.
 *
 * The stack is the one an operator deploys: the production container image,
 * PostgreSQL, a pinned Edge release, real SMTP. Nothing is stubbed, and the
 * portal has no idea it is under test.
 *
 * Run it with `./e2e/run.sh`; see `e2e/README.md`.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';

import {
  authHeadersFor,
  grantAccess,
  issueCredential,
  publishApi,
  UPSTREAM_URL,
  type IssuedCredential,
  type PublishedApi,
} from './fixtures.js';
import {
  ADMIN_PASSWORD,
  adminSession,
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

/** Compare complete secret-bearing evidence without printing it on an assertion failure. */
function evidenceDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

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

/** Run one command inside the PostgreSQL service, as its superuser over the local socket. */
async function inPostgres(...command: string[]): Promise<void> {
  await compose('exec', '-T', 'postgres', ...command);
}

/**
 * Run a shell script against the gateway's data volume (`/data`) and the
 * backup volume (`/backup`), in a one-off copy of the init container: Edge's
 * own image is distroless and has no shell to do it with.
 */
async function onGatewayVolume(script: string): Promise<void> {
  const oneOff = ['run', '--rm', '-T', '--no-deps', '--entrypoint', 'sh', 'ferrum-edge-init'];
  await compose(...oneOff, '-c', script);
}

/** The slice of a portal list response the restore case reads. */
interface Listed {
  items: { id: string; status: string }[];
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

    // The operator account `prepare.ts` bootstrapped, which also turned email
    // verification on. Signing in rather than bootstrapping is what lets this
    // suite and the browser journey share one stack: only the *first*
    // registration becomes `super_admin`, so they cannot each claim it.
    provider = await adminSession();
    assert.equal(provider.role, 'super_admin', 'the stack was not prepared — run ./e2e/run.sh');

    // Every other account goes through the real registration and verification
    // flow, mail included.
    outsider = await registerVerifiedUser(`outsider-${RUN}@example.test`, 'client');
  });

  after(async () => {
    await clearMail();
  });

  for (const level of ['docs_only', 'routes'] as const) {
    it(`${level}: converts through released deployment authority and preserves issued access`, async () => {
      const api = await publishApi(provider, {
        name: 'Conditional deployment acceptance',
        slug: `deployment-${level}-${RUN}`,
        authPlugin: 'key_auth',
        enforcement: level,
      });
      const client = await newClient();
      await grantAccess(client, provider, api.id);
      const credential = await issueCredential(client, 'keyauth');
      const headers = authHeadersFor(credential, 'keyauth');
      const beforeResponse = await gatewayAdmin('GET', '/deployment-snapshot');
      assert.equal(beforeResponse.status, 200);
      assert.equal(beforeResponse.headers.get('cache-control'), 'no-store');
      const before = (await beforeResponse.json()) as {
        profile: string;
        namespace_etag: string;
        evidence: { resources: unknown[] };
      };
      assert.equal(before.profile, 'deployment-v1');
      assert.equal(beforeResponse.headers.get('etag'), before.namespace_etag);
      assert.equal(before.evidence.resources.length, 8);
      const consumers = before.evidence.resources[1] as {
        username: string;
        credentials: { keyauth?: { key: string }[] };
      }[];
      const consumer = consumers.find((row) => row.username === credential.consumerUsername);
      assert.ok(consumer?.credentials.keyauth?.some((row) => row.key === credential.secret.key));
      const stored = await portal<{ api: { ferrum_proxy_id: string } }>(
        'GET',
        `/api/apis/${api.id}`,
        { session: provider },
      );
      const converted = await portal<{
        api: { ferrum_proxy_id: string; gateway_state: string; spec_enforcement: string };
      }>('PATCH', `/api/apis/${api.id}`, {
        session: provider,
        body: { spec_enforcement: level === 'routes' ? 'docs_only' : 'routes' },
      });
      assert.equal(converted.api.ferrum_proxy_id, stored.api.ferrum_proxy_id);
      assert.equal(converted.api.gateway_state, 'deployed');
      const afterResponse = await gatewayAdmin('GET', '/deployment-snapshot');
      assert.equal(afterResponse.status, 200);
      const after = (await afterResponse.json()) as typeof before;
      for (const index of [1, 2, 4, 6]) {
        assert.equal(
          evidenceDigest(after.evidence.resources[index]),
          evidenceDigest(before.evidence.resources[index]),
        );
      }
      const served = await callGateway(`${api.listen_path}/invoices`, { headers });
      assert.equal(served.status, 200);
      assert.ok(reachedUpstream(served));
      const unauthenticated = await callGateway(`${api.listen_path}/invoices`);
      assert.equal(unauthenticated.status, 401);
      assert.equal(reachedUpstream(unauthenticated), false);
      if (converted.api.spec_enforcement === 'routes') {
        const unknown = await callGateway(`${api.listen_path}/not-in-the-spec`, { headers });
        assert.equal(unknown.status, 400);
        assert.equal(reachedUpstream(unknown), false);
      }
    });
  }

  it('refuses a stale original token and invalid conditional modes on the actual owner', async () => {
    const api = await publishApi(provider, {
      name: 'Original authority acceptance',
      slug: `deployment-stale-${RUN}`,
      authPlugin: 'key_auth',
    });
    const client = await newClient();
    await grantAccess(client, provider, api.id);
    const credential = await issueCredential(client, 'keyauth');
    const stored = await portal<{ api: { ferrum_proxy_id: string } }>(
      'GET',
      `/api/apis/${api.id}`,
      { session: provider },
    );
    const original = await gatewayAdmin('GET', '/deployment-snapshot');
    assert.equal(original.status, 200);
    const token = original.headers.get('etag');
    assert.ok(token);
    await original.arrayBuffer();
    const unrelated = await newClient();
    await issueCredential(unrelated, 'keyauth');
    const path = `/proxies/${stored.api.ferrum_proxy_id}`;
    const stale = await gatewayAdmin(
      'DELETE',
      `${path}?conditional=true&cleanup_orphaned_upstream=false`,
      undefined,
      { 'if-match': token },
    );
    assert.equal(stale.status, 412);
    const refused = (await stale.json()) as {
      durable: string;
      live: string;
      recovery_cleanup_authorized: boolean;
    };
    assert.equal(refused.durable, 'not_committed');
    assert.equal(refused.live, 'unconfirmed');
    assert.equal(refused.recovery_cleanup_authorized, false);
    for (const query of [
      'conditional=true&conditional=true&cleanup_orphaned_upstream=false',
      'conditional=true&cleanup_orphaned_upstream=false&apply=async',
      'conditional=true&cleanup_orphaned_upstream=true',
    ]) {
      const invalid = await gatewayAdmin('DELETE', `${path}?${query}`, undefined, {
        'if-match': token,
      });
      assert.equal(invalid.status, 400);
      await invalid.arrayBuffer();
    }
    const served = await callGateway(`${api.listen_path}/invoices`, {
      headers: authHeadersFor(credential, 'keyauth'),
    });
    assert.equal(served.status, 200);
    assert.ok(reachedUpstream(served));
  });

  it('replays operator validator fields after a real catalog commit refusal', async () => {
    const api = await publishApi(provider, {
      name: 'Conditional rollback acceptance',
      slug: `deployment-rollback-${RUN}`,
      authPlugin: 'key_auth',
      enforcement: 'routes',
    });
    const client = await newClient();
    await grantAccess(client, provider, api.id);
    const credential = await issueCredential(client, 'keyauth');
    const stored = await portal<{ api: { ferrum_proxy_id: string; gateway_state: string } }>(
      'GET',
      `/api/apis/${api.id}`,
      { session: provider },
    );
    const response = await gatewayAdmin('GET', '/deployment-snapshot');
    assert.equal(response.status, 200);
    const original = (await response.json()) as {
      plugin_configs: { id: string; proxy_id: string; plugin_name: string; config: object }[];
    };
    const validator = original.plugin_configs.find(
      (plugin) =>
        plugin.proxy_id === stored.api.ferrum_proxy_id && plugin.plugin_name === 'openapi_validator',
    );
    assert.ok(validator);
    const operator = await gatewayAdmin('PUT', `/plugins/config/${validator.id}`, {
      plugin_name: 'openapi_validator',
      scope: 'proxy',
      proxy_id: stored.api.ferrum_proxy_id,
      enabled: true,
      labels: { operator: 'preserve' },
      priority_override: 2_900,
      config: { ...validator.config, request_content_types: ['application/problem+json'] },
    });
    assert.equal(operator.status, 200);
    await operator.arrayBuffer();
    const beforeResponse = await gatewayAdmin('GET', '/deployment-snapshot');
    assert.equal(beforeResponse.status, 200);
    const before = (await beforeResponse.json()) as { evidence: { resources: unknown[] } };
    await inPostgres(
      'psql',
      '-U',
      'nexus',
      '-d',
      'nexus',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      `CREATE FUNCTION deployment_commit_refusal() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id = '${api.id}' AND NEW.spec_enforcement <> OLD.spec_enforcement
      THEN RAISE EXCEPTION 'acceptance conversion commit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER deployment_commit_refusal BEFORE UPDATE ON apis
      FOR EACH ROW EXECUTE FUNCTION deployment_commit_refusal();`,
    );
    try {
      const failed = await portalRaw('PATCH', `/api/apis/${api.id}`, {
        session: provider,
        body: { spec_enforcement: 'docs_only' },
      });
      assert.equal(failed.status, 500);
      await failed.arrayBuffer();
    } finally {
      await inPostgres(
        'psql',
        '-U',
        'nexus',
        '-d',
        'nexus',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        'DROP TRIGGER deployment_commit_refusal ON apis; DROP FUNCTION deployment_commit_refusal();',
      );
    }
    const afterResponse = await gatewayAdmin('GET', '/deployment-snapshot');
    assert.equal(afterResponse.status, 200);
    const after = (await afterResponse.json()) as {
      evidence: { resources: unknown[] };
      plugin_configs: {
        id: string;
        labels: unknown;
        priority_override: number;
        config: { request_content_types: unknown };
      }[];
    };
    for (const index of [1, 2, 4, 6]) {
      assert.equal(
        evidenceDigest(after.evidence.resources[index]),
        evidenceDigest(before.evidence.resources[index]),
      );
    }
    const replayed = after.plugin_configs.find((plugin) => plugin.id === validator.id);
    assert.ok(replayed);
    assert.deepEqual(replayed.labels, { operator: 'preserve' });
    assert.equal(replayed.priority_override, 2_900);
    assert.deepEqual(replayed.config.request_content_types, ['application/problem+json']);
    const catalog = await portal<{
      api: { gateway_state: string; ferrum_proxy_id: string; spec_enforcement: string };
    }>('GET', `/api/apis/${api.id}`, { session: provider });
    assert.equal(catalog.api.gateway_state, 'deployed');
    assert.equal(catalog.api.ferrum_proxy_id, stored.api.ferrum_proxy_id);
    assert.equal(catalog.api.spec_enforcement, 'routes');
    const served = await callGateway(`${api.listen_path}/invoices`, {
      headers: authHeadersFor(credential, 'keyauth'),
    });
    assert.equal(served.status, 200);
    assert.ok(reachedUpstream(served));
  });

  /* ── The authentication matrix ────────────────────────────────────────── */

  for (const flavour of [
    // `forwardsCredential` is observed behaviour, pinned rather than wished
    // for. Edge hides the API key and the basic-auth header from the backend;
    // it forwards the bearer token, because a backend commonly wants the
    // claims. That asymmetry is worth knowing about — a provider's upstream
    // does see its clients' live JWTs — so the suite states it rather than
    // asserting a uniform rule that is not true.
    //
    // It is not Nexus's to change either. Of these three plugins only
    // `key_auth` and `basic_auth` take `hide_credentials`; `jwt_auth`'s config
    // is a closed key set that refuses it, so setting it would 400 the publish
    // rather than hide the token. `docs/api.md`, `docs/security.md` §5 and the
    // client and provider guides document the difference — if a future Edge
    // adds the option and Nexus sets it, move them with this flag.
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
          ? 'a bearer token is forwarded to the backend: jwt_auth cannot hide it'
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

  /* ── Agent tools, through the same consumer authorization ────────────── */

  interface ToolResult {
    isError?: boolean;
    structuredContent?: { method: string; path: string; body: string; routeServed: number };
    tools?: { name: string; description: string; annotations: { readOnlyHint: boolean } }[];
  }

  interface UpstreamSnapshot {
    total: number;
    byRoute: Record<string, number>;
    overflow: boolean;
  }

  let upstreamObserver: { api: PublishedApi; headers: Record<string, string> } | undefined;

  /** Read the real fixture through a separate approved REST API, never Edge's Admin API. */
  async function upstreamSnapshot(): Promise<UpstreamSnapshot> {
    if (!upstreamObserver) {
      const client = await newClient();
      const api = await publishApi(provider, {
        name: 'Upstream request observations',
        slug: `e2e-upstream-observer-${RUN}`,
        authPlugin: 'key_auth',
        enforcement: 'routes',
        paths: ['/__e2e/requests'],
      });
      await grantAccess(client, provider, api.id);
      const credential = await issueCredential(client, 'keyauth');
      const headers = authHeadersFor(credential, 'keyauth');
      await waitFor('the upstream snapshot route to be served', async () => {
        const response = await callGateway(`${api.listen_path}/__e2e/requests`, { headers });
        await response.text();
        return response.status === 200 && reachedUpstream(response);
      });
      upstreamObserver = { api, headers };
    }
    const { api, headers } = upstreamObserver;
    const response = await callGateway(`${api.listen_path}/__e2e/requests`, { headers });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.ok(reachedUpstream(response));
    const snapshot = JSON.parse(text) as UpstreamSnapshot;
    assert.equal(snapshot.overflow, false, 'the bounded fixture must retain every observed route');
    assert.ok(Number.isSafeInteger(snapshot.total) && snapshot.total >= 0);
    const counts = Object.values(snapshot.byRoute);
    assert.ok(counts.every((count) => Number.isSafeInteger(count) && count > 0));
    assert.equal(
      counts.reduce((total, count) => total + count, 0),
      snapshot.total,
      'the full per-route snapshot must account for every request, including duplicates',
    );
    return snapshot;
  }

  function withUpstreamCalls(
    before: UpstreamSnapshot,
    route: string,
    count: number,
  ): UpstreamSnapshot {
    return {
      ...before,
      total: before.total + count,
      byRoute: { ...before.byRoute, [route]: (before.byRoute[route] ?? 0) + count },
    };
  }

  // The default at the immutable v0.9.12 pin; this client supports that version.
  const MCP_PROTOCOL_VERSION = '2025-11-25';

  async function rpc(
    api: PublishedApi,
    headers: Record<string, string>,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Response> {
    return callGateway(`${api.listen_path}/mcp`, {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
  }

  async function result<T = ToolResult>(response: Response): Promise<T> {
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const body = JSON.parse(text) as { jsonrpc: string; id: number; result?: T; error?: unknown };
    assert.equal(body.jsonrpc, '2.0', text);
    assert.equal(body.id, 1, text);
    assert.equal(body.error, undefined, text);
    assert.ok(body.result, text);
    return body.result;
  }

  /** The released bridge reports a tool-policy denial as an HTTP 200 RPC error. */
  async function assertToolPolicyDenied(response: Response): Promise<void> {
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.deepEqual(JSON.parse(text), {
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32001, message: 'MCP tool call denied by gateway policy' },
    });
    assert.equal(reachedUpstream(response), false);
  }

  async function negotiatedHeaders(
    response: Response,
    headers: Record<string, string>,
  ): Promise<Record<string, string>> {
    const initialized = await result<{ protocolVersion: string }>(response);
    assert.equal(
      initialized.protocolVersion,
      MCP_PROTOCOL_VERSION,
      'initialize must negotiate a version supported by this client',
    );
    const session = response.headers.get('mcp-session-id');
    assert.ok(session, 'initialize must issue a downstream session');
    return {
      ...headers,
      'mcp-session-id': session,
      'mcp-protocol-version': initialized.protocolVersion,
    };
  }

  const agentSelections = [
    { path: '/invoices', method: 'GET', name: 'list_invoices', description: 'List invoices' },
  ];

  async function publishAgentApi(
    slug: string,
    authPlugin: string,
    visibility = 'public',
  ): Promise<PublishedApi> {
    const response = await portal<{ api: PublishedApi }>('POST', '/api/apis', {
      session: provider,
      body: {
        name: 'Agent acceptance',
        slug,
        auth_plugin: authPlugin,
        visibility,
        requestable: true,
        spec_enforcement: 'routes',
        agents: { operations: agentSelections },
        spec: JSON.stringify({
          openapi: '3.1.0',
          info: { title: 'Agent acceptance', version: '1' },
          servers: [{ url: UPSTREAM_URL }],
          // Provider-supplied extensions cannot select tools or replace grants.
          'x-ferrum-mcp': { endpoint: { path: '/escape' } },
          'x-ferrum-plugins': [
            { plugin_name: 'mcp_gateway', config: { policy: { default_action: 'allow' } } },
          ],
          paths: {
            '/invoices': {
              get: { responses: { '200': { description: 'OK' } } },
              post: {
                'x-ferrum-mcp': { expose: true },
                requestBody: {
                  required: true,
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        properties: { memo: { type: 'string' } },
                        required: ['memo'],
                      },
                    },
                  },
                },
                responses: { '200': { description: 'OK' } },
              },
            },
            '/invoices/{id}': {
              parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
              delete: {
                'x-ferrum-mcp': true,
                responses: { '200': { description: 'OK' } },
              },
            },
          },
        }),
      },
    });
    return response.api;
  }

  it('previews proposed manifests in the packaged image without fetching or disclosing references', async () => {
    const before = await upstreamSnapshot();
    const manifest = {
      schema: 'ferrum.service_manifest',
      schema_version: '1.0',
      service: { name: 'preview-acceptance', description: 'redacted description' },
      api: { public_path: '/preview', openapi: '/nonexistent/secret-openapi.json' },
      upstream: {
        host: 'secret-upstream.internal',
        port: 8443,
        scheme: 'https',
        gateway_client_cert_path: '/nonexistent/secret-client.pem',
        gateway_client_key_path: '/nonexistent/secret-client.key',
        server_ca_path: '/nonexistent/secret-ca.pem',
      },
      gateway: { namespace: 'nexus', otel_endpoint: `${UPSTREAM_URL}/manifest-must-not-fetch` },
    };
    const response = await portalRaw('POST', '/api/service-manifests/preview', {
      session: provider,
      body: { namespace: 'nexus', manifest },
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal((JSON.parse(text) as { preview_only: boolean }).preview_only, true);
    assert.equal(text.includes('[REDACTED]'), true);
    for (const secret of [
      'secret-',
      'nonexistent',
      'redacted description',
      'manifest-must-not-fetch',
    ]) {
      assert.equal(text.includes(secret), false, secret);
    }
    const foreign = await portalRaw('POST', '/api/service-manifests/preview', {
      session: provider,
      body: { namespace: 'foreign', manifest },
    });
    assert.equal(foreign.status, 403);
    const invalid = await portalRaw('POST', '/api/service-manifests/preview', {
      session: provider,
      body: { namespace: 'nexus', manifest: { ...manifest, auth: null } },
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await upstreamSnapshot(), before, 'preview performs no upstream request');
  });

  const createTool = {
    path: '/invoices',
    method: 'POST',
    name: 'create_invoice',
    description: 'Create invoice',
  };

  async function initializeAgent(
    api: PublishedApi,
    headers: Record<string, string>,
  ): Promise<Record<string, string>> {
    let response: Response | undefined;
    await waitFor('the MCP endpoint policy to initialize', async () => {
      response = await rpc(api, headers, 'initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'subset-acceptance', version: '1' },
      });
      return response.status === 200;
    });
    assert.ok(response);
    return negotiatedHeaders(response, headers);
  }

  async function grantToolSubset(
    client: Session,
    api: PublishedApi,
    applicationId?: string,
  ): Promise<void> {
    const id = api.agents?.operations.find((tool) => tool.name === 'list_invoices')?.id;
    assert.ok(id);
    const request = await portal<{ access_request: { id: string } }>(
      'POST',
      '/api/access-requests',
      {
        session: client,
        body: {
          api_id: api.id,
          application_id: applicationId,
          justification: 'Read tool only',
          requested_tools: [id],
        },
      },
    );
    await portal('POST', `/api/access-requests/${request.access_request.id}/approve`, {
      session: provider,
      body: {},
      expect: 200,
    });
  }

  for (const flavour of [
    { plugin: 'key_auth', credential: 'keyauth', application: false },
    { plugin: 'key_auth', credential: 'keyauth', application: true },
    { plugin: 'basic_auth', credential: 'basicauth', application: false },
    { plugin: 'basic_auth', credential: 'basicauth', application: true },
    { plugin: 'jwt_auth', credential: 'jwt', application: false },
    { plugin: 'jwt_auth', credential: 'jwt', application: true },
  ] as const) {
    it(`enforces provider-narrowed subsets with ${flavour.credential} ${flavour.application ? 'application' : 'account'} credentials`, async () => {
      const client = await newClient();
      let api = await publishAgentApi(
        `e2e-subsets-${flavour.credential}-${flavour.application ? 'app' : 'user'}-${RUN}`,
        flavour.plugin,
      );
      api = (
        await portal<{ api: PublishedApi }>('PATCH', `/api/apis/${api.id}`, {
          session: provider,
          body: { agents: { operations: [...agentSelections, createTool] } },
        })
      ).api;
      const readId = api.agents?.operations.find((tool) => tool.name === 'list_invoices')?.id;
      const createId = api.agents?.operations.find((tool) => tool.name === 'create_invoice')?.id;
      assert.ok(readId && createId);
      const application = flavour.application
        ? await portal<{ application: { id: string } }>('POST', '/api/applications', {
            session: client,
            body: { name: 'Subset agent app' },
          })
        : null;
      const applicationId = application?.application.id;
      const credential = await issueCredential(client, flavour.credential, applicationId);
      const headers = authHeadersFor(credential, flavour.credential);
      const request = await portal<{
        access_request: { id: string; requested_tools: string[] };
      }>('POST', '/api/access-requests', {
        session: client,
        body: {
          api_id: api.id,
          application_id: applicationId,
          justification: 'Use two published tools',
          requested_tools: [readId, createId],
        },
      });
      assert.deepEqual(request.access_request.requested_tools, [readId, createId]);
      const broadened = await portalRaw(
        'POST',
        `/api/access-requests/${request.access_request.id}/approve`,
        { session: provider, body: { approved_tools: null } },
      );
      assert.equal(broadened.status, 400);
      if (flavour.credential === 'keyauth') {
        await inPostgres(
          'psql',
          '-U',
          'nexus',
          '-d',
          'nexus',
          '-v',
          'ON_ERROR_STOP=1',
          '-c',
          `
          CREATE FUNCTION subset_grant_failure() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.api_id = '${api.id}' THEN RAISE EXCEPTION 'acceptance grant failure'; END IF; RETURN NEW; END $$;
          CREATE TRIGGER subset_grant_failure BEFORE INSERT ON grants FOR EACH ROW EXECUTE FUNCTION subset_grant_failure();
        `,
        );
        try {
          const failed = await portalRaw(
            'POST',
            `/api/access-requests/${request.access_request.id}/approve`,
            { session: provider, body: { approved_tools: [readId] } },
          );
          assert.equal(failed.status, 500, await failed.text());
        } finally {
          await inPostgres(
            'psql',
            '-U',
            'nexus',
            '-d',
            'nexus',
            '-v',
            'ON_ERROR_STOP=1',
            '-c',
            'DROP TRIGGER subset_grant_failure ON grants; DROP FUNCTION subset_grant_failure();',
          );
        }
        const beforeRollback = await upstreamSnapshot();
        const rolledBack = await rpc(api, headers, 'tools/call', {
          name: `${api.slug}.list_invoices`,
          arguments: {},
        });
        assert.equal(rolledBack.status, 403, await rolledBack.text());
        assert.equal(reachedUpstream(rolledBack), false);
        assert.deepEqual(await upstreamSnapshot(), beforeRollback);
      }
      const approval = await portal<{ grant: { id: string; approved_tools: string[] } }>(
        'POST',
        `/api/access-requests/${request.access_request.id}/approve`,
        { session: provider, body: { approved_tools: [readId] }, expect: 200 },
      );
      assert.deepEqual(approval.grant.approved_tools, [readId]);
      const sessionHeaders = await initializeAgent(api, headers);
      const list = await result(await rpc(api, sessionHeaders, 'tools/list'));
      assert.deepEqual(
        list.tools?.map((tool) => tool.name),
        [`${api.slug}.list_invoices`],
      );
      const beforeDenied = await upstreamSnapshot();
      const denied = await rpc(api, sessionHeaders, 'tools/call', {
        name: `${api.slug}.create_invoice`,
        arguments: { body: { memo: 'subset must deny' } },
      });
      await assertToolPolicyDenied(denied);
      assert.deepEqual(
        await upstreamSnapshot(),
        beforeDenied,
        'REST approval cannot bypass the MCP subset',
      );
      const called = await result(
        await rpc(api, sessionHeaders, 'tools/call', {
          name: `${api.slug}.list_invoices`,
          arguments: {},
        }),
      );
      assert.equal(called.isError, false);
      assert.equal(called.structuredContent?.method, 'GET');
      assert.equal(called.structuredContent?.path, '/invoices');
      assert.deepEqual(
        await upstreamSnapshot(),
        withUpstreamCalls(beforeDenied, 'GET /invoices', 1),
        'the approved tool dispatches exactly one read',
      );
      if (applicationId) {
        const account = authHeadersFor(
          await issueCredential(client, flavour.credential),
          flavour.credential,
        );
        const beforeAccount = await upstreamSnapshot();
        for (const method of ['tools/list', 'tools/call']) {
          const refused = await rpc(api, account, method, {
            name: `${api.slug}.list_invoices`,
            arguments: {},
          });
          assert.equal(refused.status, 403, await refused.text());
          assert.equal(reachedUpstream(refused), false);
        }
        assert.deepEqual(await upstreamSnapshot(), beforeAccount);
      }
      const rest = await callGateway(`${api.listen_path}/invoices`, { headers });
      assert.equal(rest.status, 200);
      assert.ok(reachedUpstream(rest));
      await rest.text();
      await portal('PATCH', `/api/users/${client.userId}`, {
        session: provider,
        body: { status: 'disabled' },
      });
      const beforeDisabled = await upstreamSnapshot();
      for (const method of ['tools/list', 'tools/call']) {
        const refused = await rpc(api, sessionHeaders, method, {
          name: `${api.slug}.list_invoices`,
          arguments: {},
        });
        assert.equal(refused.status, 401, await refused.text());
        assert.equal(reachedUpstream(refused), false);
      }
      assert.deepEqual(await upstreamSnapshot(), beforeDisabled);
      await portal('PATCH', `/api/users/${client.userId}`, {
        session: provider,
        body: { status: 'active' },
      });
      const beforeRetired = await upstreamSnapshot();
      const retired = await rpc(api, sessionHeaders, 'tools/call', {
        name: `${api.slug}.list_invoices`,
        arguments: {},
      });
      assert.equal(retired.status, 401, await retired.text());
      assert.equal(reachedUpstream(retired), false);
      assert.deepEqual(await upstreamSnapshot(), beforeRetired);
      const replacement = authHeadersFor(
        await issueCredential(
          await signIn(client.email, ADMIN_PASSWORD),
          flavour.credential,
          applicationId,
        ),
        flavour.credential,
      );
      const restoredSession = await initializeAgent(api, replacement);
      const restoredList = await result(await rpc(api, restoredSession, 'tools/list'));
      assert.deepEqual(
        restoredList.tools?.map((tool) => tool.name),
        [`${api.slug}.list_invoices`],
      );
      const beforeRestoredDenied = await upstreamSnapshot();
      await assertToolPolicyDenied(
        await rpc(api, restoredSession, 'tools/call', {
          name: `${api.slug}.create_invoice`,
          arguments: { body: { memo: 're-enable must retain the subset' } },
        }),
      );
      assert.deepEqual(await upstreamSnapshot(), beforeRestoredDenied);
      const restoredCall = await result(
        await rpc(api, restoredSession, 'tools/call', {
          name: `${api.slug}.list_invoices`,
          arguments: {},
        }),
      );
      assert.equal(restoredCall.isError, false);
      assert.equal(restoredCall.structuredContent?.method, 'GET');
      assert.equal(restoredCall.structuredContent?.path, '/invoices');
      assert.deepEqual(
        await upstreamSnapshot(),
        withUpstreamCalls(beforeRestoredDenied, 'GET /invoices', 1),
        'the replacement credential dispatches exactly one approved read after re-enable',
      );
      await portal('POST', `/api/grants/${approval.grant.id}/revoke`, {
        session: provider,
        body: {},
        expect: 200,
      });
      const beforeRevoke = await upstreamSnapshot();
      for (const method of ['tools/list', 'tools/call']) {
        const response = await rpc(api, restoredSession, method, {
          name: `${api.slug}.list_invoices`,
          arguments: {},
        });
        assert.equal(response.status, 403, await response.text());
        assert.equal(reachedUpstream(response), false);
      }
      assert.deepEqual(await upstreamSnapshot(), beforeRevoke);
    });
  }

  it('keeps empty and omitted subsets distinct; changes, disabling and re-enabling cannot revive old exposure IDs', async () => {
    let api = await publishAgentApi(`e2e-subset-lifecycle-${RUN}`, 'key_auth');
    const selected = await newClient();
    const empty = await newClient();
    const all = await newClient();
    const id = api.agents?.operations[0]?.id;
    assert.ok(id);
    for (const [client, subset] of [
      [selected, [id]],
      [empty, []],
      [all, null],
    ] as const) {
      const request = await portal<{ access_request: { id: string } }>(
        'POST',
        '/api/access-requests',
        {
          session: client,
          body: {
            api_id: api.id,
            justification: 'Lifecycle acceptance',
            ...(subset !== null ? { requested_tools: subset } : {}),
          },
        },
      );
      await portal('POST', `/api/access-requests/${request.access_request.id}/approve`, {
        session: provider,
        body: {},
        expect: 200,
      });
    }
    const selectedHeaders = authHeadersFor(await issueCredential(selected, 'keyauth'), 'keyauth');
    const emptyHeaders = authHeadersFor(await issueCredential(empty, 'keyauth'), 'keyauth');
    const allHeaders = authHeadersFor(await issueCredential(all, 'keyauth'), 'keyauth');
    const selectedSession = await initializeAgent(api, selectedHeaders);
    const emptySession = await initializeAgent(api, emptyHeaders);
    const allSession = await initializeAgent(api, allHeaders);
    async function names(headers: Record<string, string>): Promise<string[]> {
      const { 'mcp-session-id': _session, 'mcp-protocol-version': _version, ...auth } = headers;
      const fresh = await initializeAgent(api, auth);
      const listed = await result(await rpc(api, fresh, 'tools/list'));
      assert.ok(listed.tools, 'discovery returns an explicit tool array, even when empty');
      return listed.tools.map((tool) => tool.name);
    }
    assert.deepEqual(await names(selectedSession), [`${api.slug}.list_invoices`]);
    assert.deepEqual(await names(emptySession), []);
    const beforeEmpty = await upstreamSnapshot();
    const emptyCall = await rpc(api, emptySession, 'tools/call', {
      name: `${api.slug}.list_invoices`,
      arguments: {},
    });
    await assertToolPolicyDenied(emptyCall);
    assert.deepEqual(await upstreamSnapshot(), beforeEmpty);
    const emptyRest = await callGateway(`${api.listen_path}/invoices`, { headers: emptyHeaders });
    assert.equal(emptyRest.status, 200);
    assert.ok(reachedUpstream(emptyRest));
    await emptyRest.text();

    // A real database refusal after the Edge write must restore the previous bridge policy.
    await inPostgres(
      'psql',
      '-U',
      'nexus',
      '-d',
      'nexus',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      `
      CREATE FUNCTION subset_policy_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id = '${api.id}' THEN RAISE EXCEPTION 'acceptance policy persistence failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER subset_policy_failure BEFORE UPDATE ON apis FOR EACH ROW EXECUTE FUNCTION subset_policy_failure();
    `,
    );
    try {
      const failed = await portalRaw('PATCH', `/api/apis/${api.id}`, {
        session: provider,
        body: { agents: { operations: [{ ...agentSelections[0], name: 'renamed' }] } },
      });
      assert.equal(failed.status, 500, await failed.text());
    } finally {
      await inPostgres(
        'psql',
        '-U',
        'nexus',
        '-d',
        'nexus',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        'DROP TRIGGER subset_policy_failure ON apis; DROP FUNCTION subset_policy_failure();',
      );
    }
    await waitFor('failed publishing to restore the old subset policy', async () =>
      (await names(selectedSession)).includes(`${api.slug}.list_invoices`),
    );
    const restored = await result(
      await rpc(api, await initializeAgent(api, selectedHeaders), 'tools/call', {
        name: `${api.slug}.list_invoices`,
        arguments: {},
      }),
    );
    assert.equal(restored.isError, false);

    for (const name of ['renamed', 'list_invoices']) {
      api = (
        await portal<{ api: PublishedApi }>('PATCH', `/api/apis/${api.id}`, {
          session: provider,
          body: { agents: { operations: [{ ...agentSelections[0], name }, createTool] } },
        })
      ).api;
      assert.notEqual(api.agents?.operations[0]?.id, id);
      await waitFor(
        'renamed tools to fail closed for the old subset',
        async () => (await names(selectedSession)).length === 0,
      );
      assert.deepEqual(await names(emptySession), []);
      assert.deepEqual(
        (await names(allSession)).sort(),
        [`${api.slug}.${name}`, `${api.slug}.create_invoice`].sort(),
      );
      const beforeStale = await upstreamSnapshot();
      const stale = await rpc(api, await initializeAgent(api, selectedHeaders), 'tools/call', {
        name: `${api.slug}.${name}`,
        arguments: {},
      });
      await assertToolPolicyDenied(stale);
      assert.deepEqual(await upstreamSnapshot(), beforeStale);
    }
    const currentId = api.agents?.operations[0]?.id;
    const spec = await portal<{ raw_spec: string }>('GET', `/api/apis/${api.id}/spec`, {
      session: provider,
    });
    const changed = JSON.parse(spec.raw_spec) as { info: { version: string } };
    changed.info.version = '2';
    await portal('PUT', `/api/apis/${api.id}/spec`, {
      session: provider,
      body: { spec: JSON.stringify(changed) },
    });
    const updated = await portal<{ api: PublishedApi }>('GET', `/api/apis/${api.id}`, {
      session: provider,
    });
    assert.notEqual(updated.api.agents?.operations[0]?.id, currentId);
    assert.deepEqual(await names(selectedSession), []);
    assert.deepEqual(
      (await names(allSession)).sort(),
      [`${api.slug}.list_invoices`, `${api.slug}.create_invoice`].sort(),
    );
    const beforeSpecDenied = await upstreamSnapshot();
    await assertToolPolicyDenied(
      await rpc(api, await initializeAgent(api, selectedHeaders), 'tools/call', {
        name: `${api.slug}.list_invoices`,
        arguments: {},
      }),
    );
    assert.deepEqual(await upstreamSnapshot(), beforeSpecDenied);
    await portal('PATCH', `/api/apis/${api.id}`, { session: provider, body: { agents: null } });
    const disabledRest = await callGateway(`${api.listen_path}/invoices`, {
      headers: selectedHeaders,
    });
    assert.equal(disabledRest.status, 200);
    assert.ok(reachedUpstream(disabledRest));
    await disabledRest.text();
    api = (
      await portal<{ api: PublishedApi }>('PATCH', `/api/apis/${api.id}`, {
        session: provider,
        body: { agents: { operations: agentSelections } },
      })
    ).api;
    const enabledSelected = await initializeAgent(api, selectedHeaders);
    const enabledAll = await initializeAgent(api, allHeaders);
    assert.deepEqual(await names(enabledSelected), []);
    assert.deepEqual(await names(enabledAll), [`${api.slug}.list_invoices`]);
    const beforeEnabled = await upstreamSnapshot();
    await assertToolPolicyDenied(
      await rpc(api, enabledSelected, 'tools/call', {
        name: `${api.slug}.list_invoices`,
        arguments: {},
      }),
    );
    assert.deepEqual(await upstreamSnapshot(), beforeEnabled);
    const enabledCall = await result(
      await rpc(api, enabledAll, 'tools/call', {
        name: `${api.slug}.list_invoices`,
        arguments: {},
      }),
    );
    assert.equal(enabledCall.isError, false);
    assert.equal(enabledCall.structuredContent?.method, 'GET');
    assert.equal(enabledCall.structuredContent?.path, '/invoices');
    assert.deepEqual(
      await upstreamSnapshot(),
      withUpstreamCalls(beforeEnabled, 'GET /invoices', 1),
    );
    await portal('DELETE', `/api/apis/${api.id}`, { session: provider });
    const beforeDeleted = await upstreamSnapshot();
    const deleted = await rpc(api, enabledAll, 'tools/call', {
      name: `${api.slug}.list_invoices`,
      arguments: {},
    });
    assert.ok(deleted.status >= 400);
    assert.equal(reachedUpstream(deleted), false);
    await deleted.text();
    assert.deepEqual(await upstreamSnapshot(), beforeDeleted);
  });

  for (const flavour of [
    { plugin: 'key_auth', credential: 'keyauth', visibility: 'public', application: false },
    { plugin: 'basic_auth', credential: 'basicauth', visibility: 'private', application: false },
    { plugin: 'jwt_auth', credential: 'jwt', visibility: 'public', application: false },
    { plugin: 'key_auth', credential: 'keyauth', visibility: 'public', application: true },
  ] as const) {
    it(`grants and revokes MCP with ${flavour.credential} ${flavour.application ? 'application' : 'account'} credentials`, async () => {
      const client = await newClient();
      const api = await publishAgentApi(
        `e2e-agents-${flavour.credential}-${flavour.application ? 'app' : 'user'}-${RUN}`,
        flavour.plugin,
        flavour.visibility,
      );
      const application = flavour.application
        ? await portal<{ application: { id: string } }>('POST', '/api/applications', {
            session: client,
            body: { name: 'Agent acceptance app' },
          })
        : null;
      const applicationId = application?.application.id;
      const credential = await issueCredential(client, flavour.credential, applicationId);
      const headers = authHeadersFor(credential, flavour.credential);
      const beforeUnapproved = await upstreamSnapshot();
      await waitFor('the unapproved MCP endpoint to refuse access', async () => {
        return (await rpc(api, headers, 'tools/list')).status === 403;
      });
      for (const method of ['initialize', 'tools/list', 'tools/call']) {
        const refused = await rpc(api, headers, method, { name: `${api.slug}.list_invoices` });
        assert.equal(refused.status, 403);
        assert.equal(reachedUpstream(refused), false);
        assert.equal((await refused.text()).includes('list_invoices'), false);
      }
      assert.deepEqual(
        await upstreamSnapshot(),
        beforeUnapproved,
        'unapproved initialization, discovery and calls never dispatch to any upstream route',
      );
      if (flavour.visibility === 'private') {
        await portal('POST', `/api/apis/${api.id}/viewers`, {
          session: provider,
          body: { user_id: client.userId },
        });
      }
      const { grantId } = await grantAccess(client, provider, api.id, applicationId);
      let initialized: Response | undefined;
      await waitFor('the approved MCP endpoint to initialize', async () => {
        initialized = await rpc(api, headers, 'initialize', {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'nexus-acceptance', version: '1' },
        });
        return initialized.status === 200;
      });
      assert.ok(initialized);
      const sessionHeaders = await negotiatedHeaders(initialized, headers);
      // An older initialize request negotiates the preferred version. Reusing
      // the requested version afterwards was the failing fixture's mistake.
      const fallback = await rpc(api, headers, 'initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'nexus-negotiation', version: '1' },
      });
      const fallbackHeaders = await negotiatedHeaders(fallback, headers);
      await result(await rpc(api, fallbackHeaders, 'tools/list'));
      const listed = await result(await rpc(api, sessionHeaders, 'tools/list'));
      assert.deepEqual(
        listed.tools?.map((tool) => tool.name),
        [`${api.slug}.list_invoices`],
      );
      assert.equal(listed.tools?.[0]?.description, `[${api.slug}] List invoices`);
      assert.equal(listed.tools?.[0]?.annotations.readOnlyHint, true);
      const called = await result(
        await rpc(api, sessionHeaders, 'tools/call', {
          name: `${api.slug}.list_invoices`,
          arguments: {},
        }),
      );
      assert.equal(called.isError, false);
      assert.equal(called.structuredContent?.method, 'GET');
      assert.equal(called.structuredContent?.path, '/invoices');
      const upstreamCount = called.structuredContent?.routeServed;
      assert.ok(upstreamCount !== undefined && Number.isSafeInteger(upstreamCount));
      const beforeUnsupported = await upstreamSnapshot();
      for (const version of ['2025-03-26', '2099-01-01']) {
        for (const method of ['tools/list', 'tools/call']) {
          const unsupported = await rpc(
            api,
            { ...sessionHeaders, 'mcp-protocol-version': version },
            method,
            { name: `${api.slug}.list_invoices`, arguments: {} },
          );
          const text = await unsupported.text();
          assert.equal(unsupported.status, 400, text);
          assert.deepEqual(JSON.parse(text), {
            jsonrpc: '2.0',
            id: 1,
            error: { code: -32600, message: 'Unsupported MCP protocol version' },
          });
          assert.equal(reachedUpstream(unsupported), false);
        }
      }
      assert.deepEqual(
        await upstreamSnapshot(),
        beforeUnsupported,
        'unsupported versions never dispatch to any upstream route',
      );
      if (applicationId) {
        const accountCredential = await issueCredential(client, flavour.credential);
        const beforeAccount = await upstreamSnapshot();
        const unapprovedAccount = await rpc(
          api,
          authHeadersFor(accountCredential, flavour.credential),
          'tools/list',
        );
        assert.equal(
          unapprovedAccount.status,
          403,
          'application grants must not reach the account',
        );
        assert.equal(reachedUpstream(unapprovedAccount), false);
        await unapprovedAccount.text();
        assert.deepEqual(await upstreamSnapshot(), beforeAccount);
      }

      const beforeDestructive = await upstreamSnapshot();
      const denied = await rpc(api, sessionHeaders, 'tools/call', {
        name: `${api.slug}.delete_invoice`,
        arguments: { id: '123' },
      });
      assert.equal(denied.status, 403, await denied.text());
      assert.equal(reachedUpstream(denied), false);
      assert.deepEqual(
        await upstreamSnapshot(),
        beforeDestructive,
        'an unselected destructive tool never dispatches to any upstream route',
      );
      const rest = await callGateway(`${api.listen_path}/invoices`, { headers });
      assert.equal(rest.status, 200);
      assert.ok(reachedUpstream(rest), 'enabling MCP preserves the REST call path');
      const restBody = (await rest.json()) as { routeServed: number };
      assert.equal(
        restBody.routeServed,
        upstreamCount + 1,
        'unsupported-version calls never execute upstream',
      );
      const beforeUnknownPaths = await upstreamSnapshot();
      for (const path of ['/undeclared', '/mcp/child']) {
        const refused = await callGateway(`${api.listen_path}${path}`, { headers });
        assert.ok(refused.status >= 400);
        assert.equal(reachedUpstream(refused), false);
        await refused.text();
      }
      assert.deepEqual(await upstreamSnapshot(), beforeUnknownPaths);

      // Retain both the credential and session: authorization must be checked
      // anew on the next call, rather than relying on token/session retirement.
      await portal('POST', `/api/grants/${grantId}/revoke`, {
        session: provider,
        body: {},
        expect: 200,
      });
      const beforeRevoked = await upstreamSnapshot();
      for (const method of ['tools/list', 'tools/call']) {
        const revoked = await rpc(api, sessionHeaders, method, {
          name: `${api.slug}.list_invoices`,
          arguments: {},
        });
        assert.equal(revoked.status, 403, await revoked.text());
        assert.equal(reachedUpstream(revoked), false);
      }
      assert.deepEqual(
        await upstreamSnapshot(),
        beforeRevoked,
        'revoked discovery and calls never dispatch to any upstream route',
      );
    });
  }

  it('requires destructive opt-in and enforces argument shielding and per-consumer budgets', async () => {
    const client = await newClient();
    const api = await publishAgentApi(`e2e-agent-governance-${RUN}`, 'key_auth');
    await grantAccess(client, provider, api.id);
    const credential = await issueCredential(client, 'keyauth');
    const headers = authHeadersFor(credential, 'keyauth');
    const invalidPolicy = await portalRaw('PATCH', `/api/apis/${api.id}`, {
      session: provider,
      body: {
        agents: { operations: agentSelections, allowed_groups: ['everyone'] },
      },
    });
    assert.equal(invalidPolicy.status, 400);
    for (const plugin of ['ai_tool_governor', 'ai_transcript_audit']) {
      const editable = await portalRaw('PUT', `/api/apis/${api.id}/plugins/${plugin}`, {
        session: provider,
        body: { enabled: true, config: { default_action: 'allow', endpoint_url: UPSTREAM_URL } },
      });
      assert.equal(editable.status, plugin === 'ai_tool_governor' ? 400 : 404);
    }
    await portal('PATCH', `/api/apis/${api.id}`, {
      session: provider,
      body: {
        agents: {
          operations: [
            ...agentSelections,
            {
              path: '/invoices',
              method: 'POST',
              name: 'create_invoice',
              description: 'Create invoice',
            },
            {
              path: '/invoices/{id}',
              method: 'DELETE',
              name: 'delete_invoice',
              description: 'Delete invoice',
            },
          ],
        },
      },
    });
    let initialized: Response | undefined;
    await waitFor('the updated agent policy to initialize', async () => {
      initialized = await rpc(api, headers, 'initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'nexus-governance', version: '1' },
      });
      return initialized.status === 200;
    });
    assert.ok(initialized);
    const scoped = await negotiatedHeaders(initialized, headers);
    const tools = await result(await rpc(api, scoped, 'tools/list'));
    assert.deepEqual(
      new Set(tools.tools?.map((tool) => tool.name)),
      new Set([
        `${api.slug}.list_invoices`,
        `${api.slug}.create_invoice`,
        `${api.slug}.delete_invoice`,
      ]),
    );
    assert.equal(
      tools.tools?.find((tool) => tool.name.endsWith('.delete_invoice'))?.annotations.readOnlyHint,
      false,
    );
    const beforeDelete = await upstreamSnapshot();
    const deleted = await result(
      await rpc(api, scoped, 'tools/call', {
        name: `${api.slug}.delete_invoice`,
        arguments: { id: '123' },
      }),
    );
    assert.equal(deleted.structuredContent?.method, 'DELETE');
    assert.equal(deleted.structuredContent?.path, '/invoices/123');
    assert.equal(deleted.isError, false);
    assert.deepEqual(
      await upstreamSnapshot(),
      withUpstreamCalls(beforeDelete, 'DELETE /invoices/123', 1),
      'explicit destructive opt-in dispatches exactly one DELETE',
    );
    const beforeShielded = await upstreamSnapshot();
    const shielded = await rpc(api, scoped, 'tools/call', {
      name: `${api.slug}.create_invoice`,
      arguments: { body: { memo: 'SSN 123-45-6789' } },
    });
    assert.equal(shielded.status, 400, await shielded.text());
    assert.equal(reachedUpstream(shielded), false);
    assert.deepEqual(
      await upstreamSnapshot(),
      beforeShielded,
      'shielded arguments never dispatch to any upstream route',
    );
    const beforeInvalid = await upstreamSnapshot();
    const invalid = await rpc(api, scoped, 'tools/call', {
      name: `${api.slug}.delete_invoice`,
      arguments: { id: '../escape' },
    });
    const invalidBody = await invalid.text();
    assert.ok(invalid.status >= 400 || invalidBody.includes('error'), invalidBody);
    assert.equal(reachedUpstream(invalid), false);
    assert.deepEqual(await upstreamSnapshot(), beforeInvalid);
    const beforeMalformed = await upstreamSnapshot();
    const malformed = await callGateway(`${api.listen_path}/mcp`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: 'not-json',
    });
    assert.ok(malformed.status >= 400);
    assert.equal(reachedUpstream(malformed), false);
    await malformed.text();
    assert.deepEqual(await upstreamSnapshot(), beforeMalformed);

    // A fresh identity gives a fresh budget. Discovery never spends tool calls.
    const budgetClient = await newClient();
    await grantToolSubset(budgetClient, api);
    const budgetCredential = await issueCredential(budgetClient, 'keyauth');
    const budgetHeaders = authHeadersFor(budgetCredential, 'keyauth');
    const secondCredential = await issueCredential(budgetClient, 'keyauth');
    assert.notEqual(secondCredential.id, budgetCredential.id);
    assert.equal(secondCredential.consumerUsername, budgetCredential.consumerUsername);
    assert.equal(budgetCredential.consumerUsername, `nexus-user-${budgetClient.userId}`);
    const secondHeaders = authHeadersFor(secondCredential, 'keyauth');
    const { application } = await portal<{ application: { id: string } }>(
      'POST',
      '/api/applications',
      { session: budgetClient, body: { name: 'Independent agent budget' } },
    );
    await grantToolSubset(budgetClient, api, application.id);
    const applicationCredential = await issueCredential(budgetClient, 'keyauth', application.id);
    assert.equal(applicationCredential.consumerUsername, `nexus-app-${application.id}`);
    assert.notEqual(applicationCredential.consumerUsername, budgetCredential.consumerUsername);
    const applicationHeaders = authHeadersFor(applicationCredential, 'keyauth');
    // Arrange every grant and credential before spending the budget. No policy
    // replacement, restart or credential rotation may reset it during the proof.
    const beforeSessions = await upstreamSnapshot();
    const init = await rpc(api, budgetHeaders, 'initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'nexus-budget', version: '1' },
    });
    const budgetScoped = await negotiatedHeaders(init, budgetHeaders);
    const secondInit = await rpc(api, secondHeaders, 'initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'nexus-budget-second-credential', version: '1' },
    });
    const secondScoped = await negotiatedHeaders(secondInit, secondHeaders);
    const applicationInit = await rpc(api, applicationHeaders, 'initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'nexus-budget-application', version: '1' },
    });
    const applicationScoped = await negotiatedHeaders(applicationInit, applicationHeaders);
    assert.deepEqual(await upstreamSnapshot(), beforeSessions);
    const beforeBudget = await callGateway(`${api.listen_path}/invoices`, {
      headers: budgetHeaders,
    });
    assert.equal(beforeBudget.status, 200);
    assert.ok(reachedUpstream(beforeBudget));
    const baseline = (await beforeBudget.json()) as { routeServed: number };
    assert.ok(Number.isSafeInteger(baseline.routeServed));
    const budgetTools = await result(await rpc(api, budgetScoped, 'tools/list'));
    const beforeDiscovery = await upstreamSnapshot();
    for (let count = 0; count < 61; count += 1) {
      await result(await rpc(api, budgetScoped, 'tools/list'));
    }
    assert.deepEqual(
      await upstreamSnapshot(),
      beforeDiscovery,
      'discovery never dispatches to any upstream route',
    );
    const budgetStarted = Date.now();
    for (let count = 0; count < 60; count += 1) {
      const called = await result(
        await rpc(api, budgetScoped, 'tools/call', {
          name: `${api.slug}.list_invoices`,
          arguments: {},
        }),
      );
      assert.equal(called.isError, false);
      assert.equal(called.structuredContent?.method, 'GET');
      assert.equal(called.structuredContent?.path, '/invoices');
      assert.equal(called.structuredContent?.routeServed, baseline.routeServed + count + 1);
    }
    const exhausted = await upstreamSnapshot();
    assert.deepEqual(exhausted, withUpstreamCalls(beforeDiscovery, 'GET /invoices', 60));
    // Reinitializing must not reset a consumer's exhausted budget.
    const reinitialized = await rpc(api, budgetHeaders, 'initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'nexus-budget-new-session', version: '1' },
    });
    const renewedBudget = await negotiatedHeaders(reinitialized, budgetHeaders);
    for (const limitedHeaders of [budgetScoped, budgetScoped, renewedBudget, secondScoped]) {
      const limited = await rpc(api, limitedHeaders, 'tools/call', {
        name: `${api.slug}.list_invoices`,
        arguments: {},
      });
      const text = await limited.text();
      // MCP application errors use HTTP 200. The exact error-only envelope
      // excludes a tool result, including a disguised successful response.
      assert.equal(limited.status, 200, text);
      assert.deepEqual(JSON.parse(text), {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32015, message: 'MCP tool-call rate limit exceeded' },
      });
      assert.equal(reachedUpstream(limited), false);
      assert.deepEqual(
        await upstreamSnapshot(),
        exhausted,
        'quota denials never dispatch, including a second credential for the same account',
      );
    }
    const stillDiscoverable = await result(await rpc(api, renewedBudget, 'tools/list'));
    assert.ok(stillDiscoverable.tools);
    assert.ok(budgetTools.tools);
    assert.deepEqual(
      [...stillDiscoverable.tools].sort((left, right) => left.name.localeCompare(right.name)),
      [...budgetTools.tools].sort((left, right) => left.name.localeCompare(right.name)),
    );
    const secondDiscoverable = await result(await rpc(api, secondScoped, 'tools/list'));
    assert.ok(secondDiscoverable.tools);
    assert.deepEqual(
      [...secondDiscoverable.tools].sort((left, right) => left.name.localeCompare(right.name)),
      [...budgetTools.tools].sort((left, right) => left.name.localeCompare(right.name)),
    );
    assert.deepEqual(await upstreamSnapshot(), exhausted);
    const rest = await callGateway(`${api.listen_path}/invoices`, { headers: budgetHeaders });
    assert.equal(rest.status, 200, 'the MCP-only budget must not consume REST requests');
    assert.ok(reachedUpstream(rest));
    const afterBudget = (await rest.json()) as { routeServed: number };
    assert.equal(
      afterBudget.routeServed,
      baseline.routeServed + 61,
      'only the 60 admitted tool calls and this REST probe execute; denials and discovery do not',
    );
    const beforeApplication = await upstreamSnapshot();
    assert.deepEqual(beforeApplication, withUpstreamCalls(exhausted, 'GET /invoices', 1));
    const independent = await result(
      await rpc(api, applicationScoped, 'tools/call', {
        name: `${api.slug}.list_invoices`,
        arguments: {},
      }),
    );
    assert.equal(
      independent.isError,
      false,
      'an approved application of the exhausted account retains its own consumer budget',
    );
    assert.equal(independent.structuredContent?.method, 'GET');
    assert.equal(independent.structuredContent?.path, '/invoices');
    assert.equal(independent.structuredContent?.routeServed, baseline.routeServed + 62);
    assert.deepEqual(
      await upstreamSnapshot(),
      withUpstreamCalls(beforeApplication, 'GET /invoices', 1),
      'the same-account application dispatches exactly one admitted tool call',
    );
    assert.ok(
      Date.now() - budgetStarted < 60_000,
      'the credential and application boundary proof must finish within the 60-second window',
    );
    const audit = await portal<{ items: { action: string }[] }>(
      'GET',
      `/api/admin/audit-logs?target_id=${api.id}`,
      { session: provider },
    );
    assert.ok(audit.items.some((row) => row.action === 'api.agents_update_start'));
    assert.ok(audit.items.some((row) => row.action === 'api.update'));
  });

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

  /* ── Backup and restore of the Nexus/Edge pair (issue #286) ───────────── */

  it('restores Nexus and Edge from one backup: access still works, revocation still holds', async () => {
    // Inside the PostgreSQL container, which outlives both database drops.
    const dump = '/tmp/e2e-backup.dump';
    const kept = await newClient();
    const former = await newClient();
    const api = await publishApi(provider, {
      name: `E2E backup ${RUN}`,
      slug: `e2e-backup-${RUN}`,
      authPlugin: 'key_auth',
    });
    await grantAccess(kept, provider, api.id);
    const keptCredential = await issueCredential(kept, 'keyauth');
    const { grantId } = await grantAccess(former, provider, api.id);
    const formerCredential = await issueCredential(former, 'keyauth');
    const keptHeaders = authHeadersFor(keptCredential, 'keyauth');
    const formerHeaders = authHeadersFor(formerCredential, 'keyauth');

    await waitFor('the approved client to be served before the backup', async () => {
      const response = await callGateway(`${api.listen_path}/invoices`, { headers: keptHeaders });
      return response.status === 200;
    });
    await portal('POST', `/api/grants/${grantId}/revoke`, {
      session: provider,
      body: { reason: 'Revoked before the backup' },
      expect: 200,
    });
    await waitFor('the revoked client to be refused before the backup', async () => {
      const response = await callGateway(`${api.listen_path}/invoices`, { headers: formerHeaders });
      return response.status === 403;
    });

    // The backup, in the runbook's order (docs/operations.md §5): stop Nexus
    // first so it cannot write to Edge after Edge's copy is taken, then Edge,
    // then copy both stores while nothing writes to either. The two copies are
    // one point in time only because both writers are stopped.
    await compose('stop', 'nexus');
    await compose('stop', 'ferrum-edge');
    await inPostgres('pg_dump', '-U', 'nexus', '--format=custom', `--file=${dump}`, 'nexus');
    await onGatewayVolume(
      'rm -rf /backup/edge && mkdir -p /backup/edge && cp -a /data/. /backup/edge/',
    );

    // The disaster: both stores lost.
    await inPostgres('sh', '-c', 'dropdb -U nexus --force nexus && createdb -U nexus nexus');
    await onGatewayVolume('rm -rf /data/* /data/.[!.]*');

    // The restore: both stores back from the same backup, then Edge before
    // Nexus, with every secret unchanged. Nexus migrates the restored database
    // on boot, which must be a no-op.
    await inPostgres('pg_restore', '-U', 'nexus', '-d', 'nexus', '--exit-on-error', dump);
    await onGatewayVolume('cp -a /backup/edge/. /data/ && chown -R 65532:65532 /data');
    await compose('start', 'ferrum-edge');
    await compose('start', 'nexus');
    await waitForStack();

    // An authenticated request through the restored pair, with the credential
    // issued before the backup — show-once material the restore could only
    // keep because Edge's own copy of it came back.
    await waitFor('the restored gateway to serve the approved client', async () => {
      const response = await callGateway(`${api.listen_path}/invoices`, { headers: keptHeaders });
      return response.status === 200;
    });
    const served = await callGateway(`${api.listen_path}/invoices`, { headers: keptHeaders });
    assert.equal(served.status, 200);
    assert.ok(reachedUpstream(served), 'the restored pair reaches the real upstream');

    // Revocation survived: the credential still authenticates, the grant is
    // still gone, and the request never reaches the backend.
    const refused = await callGateway(`${api.listen_path}/invoices`, { headers: formerHeaders });
    assert.equal(refused.status, 403);
    assert.equal(reachedUpstream(refused), false);

    // And the portal agrees with the gateway. The sessions below were issued
    // before the backup; they still resolve only because NEXUS_SECRET_KEY did
    // not change.
    const grants = await portal<Listed>('GET', '/api/grants', { session: former, expect: 200 });
    assert.equal(grants.items.find((grant) => grant.id === grantId)?.status, 'revoked');
    const issued = await portal<Listed>('GET', '/api/credentials', { session: kept, expect: 200 });
    assert.equal(issued.items.find((item) => item.id === keptCredential.id)?.status, 'active');
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
async function gatewayAdmin(
  method: 'GET' | 'PUT' | 'DELETE',
  path: string,
  document?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const { createHmac, randomUUID } = await import('node:crypto');
  const secret = process.env.FERRUM_ADMIN_JWT_SECRET;
  const issuer = process.env.FERRUM_ADMIN_JWT_ISSUER ?? 'ferrum-edge';
  const namespace = process.env.FERRUM_NAMESPACE ?? 'nexus';
  const adminUrl = process.env.E2E_ADMIN_URL ?? 'http://127.0.0.1:9000';
  if (!secret) throw new Error('FERRUM_ADMIN_JWT_SECRET is required for owner protocol acceptance');

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

  return fetch(`${adminUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'X-Ferrum-Namespace': namespace,
      ...(document === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(document === undefined ? {} : { body: JSON.stringify(document) }),
  });
}

async function deleteProxyOnGateway(proxyId: string): Promise<void> {
  const response = await gatewayAdmin('DELETE', `/proxies/${encodeURIComponent(proxyId)}`);
  if (response.status >= 400 && response.status !== 404) {
    throw new Error(`Deleting proxy ${proxyId} answered ${response.status}`);
  }
}
