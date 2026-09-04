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

import { SAMPLE_SPEC_YAML, buildTestApp, type TestApp, type TestSession } from './helpers.js';

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
