/**
 * Two Nexus instances, one database, one gateway.
 *
 * This is the topology GHSA-3r76-f92m-5x8v is about: `PUT /consumers/{id}` is a
 * whole-resource replace with no concurrency token, and the promise queue in
 * `ferrum-admin/client.ts` only ever ordered calls inside a single Node
 * process. Two processes therefore had two locks, which is no lock — a revoke
 * on one and an approval on the other both read `[A]`, and whichever wrote last
 * decided what the gateway enforced. The losing write was silent: Nexus
 * recorded the revocation, Edge kept authorising it.
 *
 * Both apps here share one store and one mock gateway, so the only thing that
 * can order them is the `edge_leases` row the serializer takes. The assertion
 * is deliberately the end-to-end one — **the consumer's ACL groups on the
 * gateway equal the grants Nexus recorded** — because that equality is exactly
 * what the advisory says used to break.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  aclGroupForApi,
  consumerUsernameForUser,
  type ApproveAccessRequestResponse,
  type CreateAccessRequestResponse,
  type PublishApiResponse,
} from '@ferrum-nexus/shared';

import {
  SAMPLE_SPEC_YAML,
  buildTestApp,
  specWithServer,
  type TestApp,
  type TestSession,
} from './helpers.js';

/** Milliseconds the first `PUT /consumers/{id}` is held, to force an overlap. */
const OVERLAP_MS = 150;

/** Head start the leading operation gets, so it is the one that is held. */
const STAGGER_MS = 30;

describe('two instances over one database', () => {
  /** "Instance 1" — owns the store and the mock gateway. */
  let one: TestApp;
  /** "Instance 2" — a second Fastify app on the same store and gateway. */
  let two: TestApp;
  let provider: TestSession;
  let slugCounter = 0;

  before(async () => {
    one = await buildTestApp();
    two = await buildTestApp({ store: one.store, edge: one.edge });
    // The first account registered anywhere becomes the super admin; the
    // provider is the second, and publishes both APIs.
    await one.registerUser({ email: 'instance-race-admin@example.test' });
    provider = await one.registerUser({
      email: 'instance-race-provider@example.test',
      role: 'provider',
    });
  });

  after(async () => {
    // `two` shares `one`'s store and gateway, so it must be closed first and
    // leaves both alone; `one` owns and tears them down.
    await two.close();
    await one.close();
  });

  async function publish(): Promise<string> {
    slugCounter += 1;
    const slug = `instance-race-${slugCounter}`;
    const response = await one.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: {
        name: `Instance Race ${slugCounter}`,
        slug,
        spec: SAMPLE_SPEC_YAML,
        auth_plugin: 'key_auth',
        requestable: true,
        visibility: 'public',
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<PublishApiResponse>().api.id;
  }

  async function requestAccess(client: TestSession, apiId: string): Promise<string> {
    const response = await one.authed(client, {
      method: 'POST',
      url: '/api/access-requests',
      payload: { api_id: apiId, justification: 'Two instances, one consumer.' },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<CreateAccessRequestResponse>().access_request.id;
  }

  async function approve(app: TestApp, requestId: string): Promise<string> {
    const response = await app.authed(provider, {
      method: 'POST',
      url: `/api/access-requests/${requestId}/approve`,
      payload: {},
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json<ApproveAccessRequestResponse>().grant.id;
  }

  /** The ACL groups the gateway would actually enforce for this user. */
  function gatewayGroups(userId: string): string[] {
    const consumer = one.edge.consumerByUsername(consumerUsernameForUser(userId));
    assert.ok(consumer, 'the user should have a gateway consumer by now');
    return [...consumer.acl_groups].sort();
  }

  /** The ACL groups Nexus's own records say the user should hold. */
  async function recordedGroups(userId: string): Promise<string[]> {
    const grants = await one.store.grants.listActiveByUser(userId);
    return grants.map((grant) => aclGroupForApi(grant.api_id)).sort();
  }

  /**
   * Revoke grant A on one instance while approving request B on the other, with
   * the gateway holding whichever `PUT /consumers/{id}` arrives first so the
   * two read-modify-writes genuinely overlap.
   *
   * Holding the **write** is what opens the lost-update window: the leader has
   * read `[A]` and its replacement body is in flight but not yet applied, so a
   * follower that is not blocked reads `[A]` too and writes over it. Whichever
   * of the two `PUT`s lands last decides what the gateway enforces — `[]` with
   * the approval lost, or `[A, B]` with the revocation lost and a withdrawn API
   * authorising the consumer again. Holding the *read* would prove nothing:
   * the mock serves a delayed `GET` from whatever is current when the delay
   * ends, not from what was there when it arrived.
   *
   * @param revokeFirst which operation is started first, and therefore held
   */
  async function race(revokeFirst: boolean): Promise<void> {
    const apiA = await publish();
    const apiB = await publish();
    const client = await one.registerUser({
      email: `instance-race-client-${slugCounter}@example.test`,
    });

    // Grant A, and leave B pending. Approving A is also what provisions the
    // consumer, so both racing operations act on a resource that already
    // exists.
    const grantA = await approve(one, await requestAccess(client, apiA));
    const requestB = await requestAccess(client, apiB);
    assert.deepEqual(gatewayGroups(client.user.id), [aclGroupForApi(apiA)]);

    // The barrier: the first consumer write is parked in flight long enough
    // for the other instance to read, decide and write.
    one.edge.delay('/consumers/', OVERLAP_MS, 'PUT');

    const revoke = (): Promise<{ statusCode: number; body: string }> =>
      one.authed(provider, { method: 'POST', url: `/api/grants/${grantA}/revoke`, payload: {} });
    const approveB = (): Promise<{ statusCode: number; body: string }> =>
      two.authed(provider, {
        method: 'POST',
        url: `/api/access-requests/${requestB}/approve`,
        payload: {},
      });

    const [first, second] = revokeFirst ? [revoke, approveB] : [approveB, revoke];
    const started = first();
    // Long enough for the leader to reach its held PUT, short enough that the
    // follower still arrives while that PUT is in flight.
    await new Promise((resolve) => setTimeout(resolve, STAGGER_MS));
    const [firstResponse, secondResponse] = await Promise.all([started, second()]);

    assert.equal(firstResponse.statusCode, 200, firstResponse.body);
    assert.equal(secondResponse.statusCode, 200, secondResponse.body);

    // Both operations landed, so Nexus records exactly one active grant: B.
    assert.deepEqual(await recordedGroups(client.user.id), [aclGroupForApi(apiB)]);
    // …and that is what the gateway enforces. A lost update would show up here
    // as `[A, B]` (the revocation overwritten) or `[]` (the approval
    // overwritten), both of which the database records deny.
    assert.deepEqual(
      gatewayGroups(client.user.id),
      await recordedGroups(client.user.id),
      'the gateway consumer must match what Nexus recorded',
    );
    assert.ok(
      !gatewayGroups(client.user.id).includes(aclGroupForApi(apiA)),
      'a revoked API must not still authorise the consumer',
    );
  }

  it('revoke on one instance, approve on the other', async () => {
    await race(true);
  });

  it('approve on one instance, revoke on the other', async () => {
    await race(false);
  });
});

/**
 * A `routes` spec revision racing a runtime `PATCH` on the same proxy.
 *
 * `PUT /api-specs/{id}` re-inserts the proxy from the submitted
 * `x-ferrum-proxy`, so it is a whole-resource proxy write wearing a different
 * URL — and it used to be issued from a document read *outside* the canonical
 * `proxy:<id>` lease every other rewrite takes. A `PATCH` landing in between
 * therefore wrote `allowed_methods`, the timeouts and `allowed_ws_origins` onto
 * a proxy the spec importer was about to overwrite from a snapshot taken before
 * them. Both requests answered `200`; only one of the two changes survived.
 */
describe('a routes spec revision racing a runtime PATCH', () => {
  let one: TestApp;
  let two: TestApp;
  let provider: TestSession;
  let counter = 0;

  before(async () => {
    one = await buildTestApp();
    two = await buildTestApp({ store: one.store, edge: one.edge });
    await one.registerUser({ email: 'spec-race-admin@example.test' });
    provider = await one.registerUser({
      email: 'spec-race-provider@example.test',
      role: 'provider',
    });
  });

  after(async () => {
    await two.close();
    await one.close();
  });

  async function publishRoutesApi(server: string): Promise<{ apiId: string; proxyId: string }> {
    counter += 1;
    const slug = `spec-race-${counter}`;
    const response = await one.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: {
        name: `Spec Race ${counter}`,
        slug,
        spec: specWithServer(server),
        auth_plugin: 'key_auth',
        requestable: true,
        visibility: 'public',
        spec_enforcement: 'routes',
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    const api = response.json<PublishApiResponse>().api;
    return { apiId: api.id, proxyId: String(api.ferrum_proxy_id) };
  }

  /** The proxy document the gateway currently holds. */
  function proxyOf(proxyId: string): Record<string, unknown> {
    const proxy = one.edge.proxies.get(`nexus/${proxyId}`);
    assert.ok(proxy, `expected proxy ${proxyId} to exist`);
    return proxy;
  }

  const RUNTIME_PATCH = {
    allowed_methods: ['GET'],
    timeouts: { connect_ms: 1001, read_ms: 2002, write_ms: 3003 },
    cors: { allowed_origins: ['https://app.example.com'], allow_credentials: false },
  };

  /**
   * Run both operations with the leader's gateway write in flight when the
   * follower arrives.
   *
   * @param specFirst whether the spec revision is the operation that is held
   */
  async function race(specFirst: boolean): Promise<void> {
    const { apiId, proxyId } = await publishRoutesApi('https://v1.example.com:8443/v1');

    const specUpdate = (): Promise<{ statusCode: number; body: string }> =>
      one.authed(provider, {
        method: 'PUT',
        url: `/api/apis/${apiId}/spec`,
        payload: { spec: specWithServer('https://v2.example.com:8443/v1', '3.0.0') },
      });
    const runtimePatch = (): Promise<{ statusCode: number; body: string }> =>
      two.authed(provider, { method: 'PATCH', url: `/api/apis/${apiId}`, payload: RUNTIME_PATCH });

    one.edge.delay(specFirst ? '/api-specs/' : '/proxies/', OVERLAP_MS, 'PUT');
    const [first, second] = specFirst ? [specUpdate, runtimePatch] : [runtimePatch, specUpdate];
    const started = first();
    await new Promise((resolve) => setTimeout(resolve, STAGGER_MS));
    const [firstResponse, secondResponse] = await Promise.all([started, second()]);
    assert.equal(firstResponse.statusCode, 200, firstResponse.body);
    assert.equal(secondResponse.statusCode, 200, secondResponse.body);

    // Both changes are on the gateway: the document's backend move and every
    // runtime field the PATCH set.
    const proxy = proxyOf(proxyId);
    assert.equal(proxy.backend_host, 'v2.example.com', 'the spec revision moved the backend');
    assert.deepEqual(
      proxy.allowed_methods,
      ['GET', 'OPTIONS'],
      'the method restriction survived the spec revision',
    );
    assert.equal(proxy.backend_connect_timeout_ms, 1001);
    assert.equal(proxy.backend_read_timeout_ms, 2002);
    assert.equal(proxy.backend_write_timeout_ms, 3003);
    assert.deepEqual(proxy.allowed_ws_origins, ['https://app.example.com']);

    // …and both are what Nexus recorded.
    const row = await one.store.apis.findById(apiId);
    assert.equal(row?.upstream_url, 'https://v2.example.com:8443/v1');
    assert.deepEqual(row?.allowed_methods, ['GET']);
    assert.deepEqual(row?.timeouts, { connect_ms: 1001, read_ms: 2002, write_ms: 3003 });
    assert.deepEqual(row?.cors, RUNTIME_PATCH.cors);

    // The auth and ACL plugins the API was published with are still associated.
    const running = one.edge
      .effectivePluginsForProxy(proxyId)
      .map((plugin) => String(plugin.plugin_name))
      .sort();
    assert.deepEqual(running, ['access_control', 'cors', 'key_auth', 'openapi_validator']);
  }

  it('keeps both changes when the spec revision is the write in flight', async () => {
    await race(true);
  });

  it('keeps both changes when the runtime PATCH is the write in flight', async () => {
    await race(false);
  });

  it('compensates a failed revision without eating a concurrent PATCH', async () => {
    const { apiId, proxyId } = await publishRoutesApi('https://v1.example.com:8443/v1');

    // The store goes down after the gateway has already been moved, which is
    // the one seam the compensation exists for.
    const real = one.store.transaction.bind(one.store);
    one.store.transaction = async <T>(): Promise<T> => {
      one.store.transaction = real;
      throw new Error('database is gone');
    };

    one.edge.delay('/api-specs/', OVERLAP_MS, 'PUT');
    const specUpdate = one.authed(provider, {
      method: 'PUT',
      url: `/api/apis/${apiId}/spec`,
      payload: { spec: specWithServer('https://v2.example.com:8443/v1', '3.0.0') },
    });
    await new Promise((resolve) => setTimeout(resolve, STAGGER_MS));
    const patched = await two.authed(provider, {
      method: 'PATCH',
      url: `/api/apis/${apiId}`,
      payload: {
        allowed_methods: ['GET'],
        timeouts: { connect_ms: 1001, read_ms: 2002, write_ms: 3003 },
      },
    });
    const failed = await specUpdate;

    assert.notEqual(failed.statusCode, 200);
    assert.equal(patched.statusCode, 200, patched.body);

    // The revision was rolled back on both sides…
    const proxy = proxyOf(proxyId);
    assert.equal(proxy.backend_host, 'v1.example.com', 'the backend move was compensated');
    const specs = await one.store.apiSpecs.list({ api_id: apiId });
    assert.equal(specs.total, 1, 'no revision was stored');
    assert.equal(
      (await one.store.apis.findById(apiId))?.upstream_url,
      'https://v1.example.com:8443/v1',
    );

    // …and the compensation did not take the concurrent PATCH down with it.
    assert.deepEqual(proxy.allowed_methods, ['GET']);
    assert.equal(proxy.backend_connect_timeout_ms, 1001);
    assert.equal(proxy.backend_read_timeout_ms, 2002);
    assert.equal(proxy.backend_write_timeout_ms, 3003);
    const running = one.edge
      .effectivePluginsForProxy(proxyId)
      .map((plugin) => String(plugin.plugin_name))
      .sort();
    assert.deepEqual(running, ['access_control', 'key_auth', 'openapi_validator']);
  });
});
