/**
 * Gateway writes whose acknowledgement never arrives.
 *
 * A `PUT` or a `POST` Ferrum Edge applied and could not answer for — a timeout,
 * a dropped connection, a proxy in front of Edge returning 502 — rejects in the
 * caller exactly like one Edge refused. Nothing on the wire tells the two apart,
 * so compensation cannot be registered *after* the call it undoes returns: the
 * gateway keeps the change while the row, the response and the audit trail all
 * roll back, and no request afterwards is able to notice.
 *
 * Three of those transitions are covered here, one per shape:
 *
 * - **the backend move** in `PATCH /api/apis/:id`, where the visible effect is
 *   live traffic proxied to a host the catalog does not name;
 * - **the proxy runtime-settings write** in the same handler, where the effect
 *   is `allowed_ws_origins` emptied on the gateway while the portal still shows
 *   the WebSocket origin policy it thinks is being enforced;
 * - **the proxy create** in `POST /api/apis`, where the rollback used to have
 *   nothing to delete because the id it deletes came from the answer that was
 *   lost — leaving a live, ungated proxy with no `apis` row and no audit row.
 *
 * Every case additionally asserts the record an operator has to be able to find
 * when the compensation itself cannot finish. A swallowed compensation and a
 * successful one used to be indistinguishable.
 */

import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import type { GetApiResponse, PublishApiResponse } from '@ferrum-nexus/shared';

import { SAMPLE_SPEC_YAML, buildTestApp, type TestApp, type TestSession } from './helpers.js';

/** Body of `POST /api/apis` for an API with a proxy and an auth plugin. */
function publishPayload(
  slug: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: `Lost ack ${slug}`,
    slug,
    version: '2.4.0',
    spec: SAMPLE_SPEC_YAML,
    auth_plugin: 'key_auth',
    requestable: false,
    visibility: 'public',
    ...overrides,
  };
}

/** The `details` of every row of `action` this API accumulated. */
async function rowsFor(
  app: TestApp,
  action: string,
  apiId: string,
): Promise<Record<string, unknown>[]> {
  const rows = await app.auditRows(action);
  return rows.filter((row) => row.target_id === apiId).map((row) => row.details);
}

describe('a gateway write whose acknowledgement is lost', () => {
  let harness: TestApp;
  let provider: TestSession;

  before(async () => {
    harness = await buildTestApp();
    await harness.registerUser({ email: 'lost-ack-founder@example.test' });
    provider = await harness.registerUser({
      email: 'lost-ack-provider@example.test',
      role: 'provider',
    });
  });

  after(async () => {
    await harness.close();
  });

  // Both injections are one-shot *and* matched: one a test armed but never met
  // would stay armed and fire inside the next test instead.
  afterEach(() => {
    harness.edge.clearInjections();
  });

  /** Publish `payload` and return the API plus its proxy id. */
  async function publish(
    payload: Record<string, unknown>,
  ): Promise<{ id: string; proxyId: string }> {
    const published = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload,
    });
    assert.equal(published.statusCode, 201, published.body);
    const api = published.json<PublishApiResponse>().api;
    return { id: api.id, proxyId: String(api.ferrum_proxy_id) };
  }

  /* ── PATCH: the backend move ──────────────────────────────────────────── */

  it('puts the backend back when the move landed and the answer did not', async () => {
    const { id, proxyId } = await publish(publishPayload('lost-ack-backend'));
    const initial = harness.edge.proxies.get(`nexus/${proxyId}`);
    assert.equal(initial?.backend_host, 'billing.example.com');

    // The move itself: applied against the stored proxy, then answered 503.
    harness.edge.queueLostAck(503, { error: 'timeout' }, '/proxies/', 'PUT');
    const failed = await harness.authed(provider, {
      method: 'PATCH',
      url: `/api/apis/${id}`,
      payload: { upstream_url: 'https://moved-elsewhere.example.com:9443/v3' },
    });
    assert.equal(failed.statusCode, 502, failed.body);

    // The compensation was registered before the `PUT`, so it ran: the gateway
    // is pointed where the catalog says it is.
    const restored = harness.edge.proxies.get(`nexus/${proxyId}`);
    assert.equal(restored?.backend_host, 'billing.example.com');
    assert.equal(restored?.backend_port, 8443);
    assert.equal(restored?.backend_scheme, 'https');
    assert.equal(restored?.backend_path, '/v2');

    const reread = await harness.authed(provider, { method: 'GET', url: `/api/apis/${id}` });
    assert.equal(
      reread.json<GetApiResponse>().api.upstream_url,
      'https://billing.example.com:8443/v2',
    );
    assert.deepEqual(await rowsFor(harness, 'api.update', id), []);
    // Nothing drifted, so nothing to repair.
    assert.deepEqual(await rowsFor(harness, 'api.gateway_repair_required', id), []);
  });

  it('records a repair when the backend restore cannot be replayed either', async () => {
    const { id, proxyId } = await publish(publishPayload('lost-ack-backend-stuck'));

    // The move lands and is not acknowledged; the restore that follows is
    // refused outright, so the gateway keeps the new backend.
    harness.edge.queueLostAck(503, { error: 'timeout' }, '/proxies/', 'PUT');
    harness.edge.queueFailure(503, { error: 'unavailable' }, '/proxies/', 'PUT', 1);
    const failed = await harness.authed(provider, {
      method: 'PATCH',
      url: `/api/apis/${id}`,
      // `name` is settled before the first gateway call, so it is what
      // `attempted_changes` has to name: the row reports how far the PATCH got,
      // not the step that threw.
      payload: {
        name: 'Renamed mid-move',
        upstream_url: 'https://moved-elsewhere.example.com:9443/v3',
      },
    });
    assert.equal(failed.statusCode, 502, failed.body);

    assert.equal(
      harness.edge.proxies.get(`nexus/${proxyId}`)?.backend_host,
      'moved-elsewhere.example.com',
      'the gateway kept the move — which is exactly what the repair row is for',
    );

    const rows = await rowsFor(harness, 'api.gateway_repair_required', id);
    assert.equal(rows.length, 1, 'one row per request, however many steps failed');
    const details = rows[0] ?? {};
    assert.equal(details.phase, 'compensation');
    assert.equal(details.proxy_id, proxyId);
    assert.deepEqual(details.steps, ['the upstream backend']);
    assert.deepEqual(details.attempted_changes, ['name']);
    assert.equal(Array.isArray(details.step_errors), true);
    assert.equal(typeof details.error, 'string');
    // Captured Edge resources never cross into the audit log.
    assert.equal('proxy' in details, false);
  });

  /* ── PATCH: the proxy runtime settings ────────────────────────────────── */

  it('puts allowed_ws_origins back when the settings write landed and the answer did not', async () => {
    const cors = {
      allowed_origins: ['https://app.example.com'],
      allow_credentials: false,
      enforce_websocket_origins: true,
    };
    const { id, proxyId } = await publish(publishPayload('lost-ack-ws', { cors }));
    assert.deepEqual(harness.edge.proxies.get(`nexus/${proxyId}`)?.allowed_ws_origins, [
      'https://app.example.com',
    ]);

    // Dropping the policy disassociates the `cors` config with one
    // `PUT /proxies/{id}` and then empties `allowed_ws_origins` with a second.
    // The second is the one under test.
    harness.edge.queueLostAck(503, { error: 'timeout' }, '/proxies/', 'PUT', 1);
    const failed = await harness.authed(provider, {
      method: 'PATCH',
      url: `/api/apis/${id}`,
      payload: { cors: null },
    });
    assert.equal(failed.statusCode, 502, failed.body);

    // The CSWSH check the portal still displays is the one the gateway runs.
    assert.deepEqual(
      harness.edge.proxies.get(`nexus/${proxyId}`)?.allowed_ws_origins,
      ['https://app.example.com'],
      'the origin allow-list was restored, not left empty on the gateway',
    );
    const reread = await harness.authed(provider, { method: 'GET', url: `/api/apis/${id}` });
    assert.deepEqual(reread.json<GetApiResponse>().api.cors?.allowed_origins, [
      'https://app.example.com',
    ]);
    assert.deepEqual(await rowsFor(harness, 'api.update', id), []);
    assert.deepEqual(await rowsFor(harness, 'api.gateway_repair_required', id), []);
  });

  it('leaves no undo behind when the settings write is a no-op', async () => {
    // The mutator returns `null` and no `PUT` is issued at all, which is the
    // one case where suppressing the undo is sound. Re-submitting the same
    // timeouts must therefore still succeed rather than replay a restore.
    const timeouts = { connect_ms: 4000, read_ms: 20000, write_ms: 20000 };
    const { id, proxyId } = await publish(publishPayload('lost-ack-noop', { timeouts }));
    const patched = await harness.authed(provider, {
      method: 'PATCH',
      url: `/api/apis/${id}`,
      payload: { timeouts, description: 'Unchanged settings, changed prose' },
    });
    assert.equal(patched.statusCode, 200, patched.body);
    assert.equal(harness.edge.proxies.get(`nexus/${proxyId}`)?.backend_connect_timeout_ms, 4000);
  });

  /* ── POST: the proxy create ───────────────────────────────────────────── */

  /** Proxies the mock holds in the portal's namespace. */
  function namespaceProxies(): Record<string, unknown>[] {
    return [...harness.edge.proxies.values()].filter((proxy) => proxy.namespace === 'nexus');
  }

  it('deletes the proxy when the create landed and the answer did not', async () => {
    const existing = namespaceProxies().length;
    const seen = harness.edge.requests.length;

    harness.edge.queueLostAck(503, { error: 'timeout' }, '/proxies', 'POST');
    const failed = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: publishPayload('lost-ack-create'),
    });
    assert.equal(failed.statusCode, 502, failed.body);

    // The id travels in the create body, so the request the mock recorded is
    // what says which proxy the rollback had to delete.
    const calls = harness.edge.requests.slice(seen);
    const create = calls.find((call) => call.method === 'POST' && call.path === '/proxies');
    assert.ok(create, 'the create really was dispatched');
    const proxyId = String((create.body as Record<string, unknown>).id);
    assert.ok(
      calls.some((call) => call.method === 'DELETE' && call.path === `/proxies/${proxyId}`),
      'the rollback deleted the proxy the create was told to make, answer or no answer',
    );
    assert.equal(harness.edge.proxies.get(`nexus/${proxyId}`), undefined);
    assert.equal(namespaceProxies().length, existing);
    assert.equal(harness.edge.proxyByName('nexus-lost-ack-create'), undefined);

    const rows = await harness.auditRows('api.publish_rollback');
    const row = rows.find((entry) => entry.details.slug === 'lost-ack-create');
    assert.ok(row, 'the attempt that reached the gateway is recorded');
    assert.equal(row.details.withdrawn, true);
    assert.equal(row.details.proxy_id, proxyId);
    assert.equal('stranded_proxy_id' in row.details, false);
    const published = await harness.auditRows('api.publish');
    assert.equal(
      published.some((entry) => entry.details.slug === 'lost-ack-create'),
      false,
      'a publish that never committed writes no success row',
    );
  });

  it('deletes the spec-owned proxy when the create landed and the answer did not', async () => {
    const existing = namespaceProxies().length;
    const seen = harness.edge.requests.length;

    // `routes` mode builds the proxy through the spec importer instead, and
    // deleting the proxy cascades the spec and its generated validator.
    harness.edge.queueLostAck(503, { error: 'timeout' }, '/api-specs', 'POST');
    const failed = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: publishPayload('lost-ack-routes', { spec_enforcement: 'routes' }),
    });
    assert.equal(failed.statusCode, 502, failed.body);

    const calls = harness.edge.requests.slice(seen);
    const create = calls.find((call) => call.method === 'POST' && call.path === '/api-specs');
    assert.ok(create, 'the spec import really was dispatched');
    const submitted = (create.body as Record<string, unknown>)['x-ferrum-proxy'] as
      | Record<string, unknown>
      | undefined;
    assert.ok(submitted, 'the spec carried the proxy body the id was minted into');
    const proxyId = String(submitted.id);
    assert.ok(
      calls.some((call) => call.method === 'DELETE' && call.path === `/proxies/${proxyId}`),
      'the rollback deleted the proxy the spec importer was told to make',
    );
    assert.equal(namespaceProxies().length, existing);
    assert.equal(harness.edge.proxyByName('nexus-lost-ack-routes'), undefined);

    const rows = await harness.auditRows('api.publish_rollback');
    const row = rows.find((entry) => entry.details.slug === 'lost-ack-routes');
    assert.ok(row);
    assert.equal(row.details.withdrawn, true);
    assert.equal(row.details.spec_enforcement, 'routes');
    assert.equal(row.details.proxy_id, proxyId);
  });

  it('names the stranded proxy when the rollback delete cannot be confirmed', async () => {
    harness.edge.queueLostAck(503, { error: 'timeout' }, '/proxies', 'POST');
    harness.edge.queueFailure(503, { error: 'unavailable' }, '/proxies/', 'DELETE');
    const failed = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: publishPayload('lost-ack-stranded'),
    });
    assert.equal(failed.statusCode, 502, failed.body);

    const stranded = harness.edge.proxyByName('nexus-lost-ack-stranded');
    assert.ok(stranded, 'the proxy really is still on the gateway');

    const rows = await harness.auditRows('api.publish_rollback');
    const row = rows.find((entry) => entry.details.slug === 'lost-ack-stranded');
    assert.ok(row, 'the only record that this proxy exists');
    assert.equal(row.details.withdrawn, false);
    assert.equal(
      row.details.stranded_proxy_id,
      String(stranded.id),
      'the id an operator needs to delete it by hand',
    );

    // Leave the namespace as the other tests expect to find it.
    harness.edge.proxies.delete(`nexus/${String(stranded.id)}`);
  });

  it('records nothing when a publish is refused before it touches the gateway', async () => {
    const recorded = (await harness.auditRows('api.publish_rollback')).length;
    const refused = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: publishPayload('lost-ack-refused', { name: '   ' }),
    });
    assert.equal(refused.statusCode, 400, refused.body);
    assert.equal((await harness.auditRows('api.publish_rollback')).length, recorded);
  });
});
