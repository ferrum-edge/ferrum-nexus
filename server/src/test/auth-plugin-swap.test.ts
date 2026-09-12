/**
 * Issue #234 — an `auth_plugin` change may not cut callers off in silence.
 *
 * Edge runs exactly one flavour of authentication per proxy, so replacing the
 * plugin stops every credential of the outgoing flavour at that proxy the
 * instant the swap lands. Nothing in the portal used to say so: the PATCH
 * answered `200`, the credential rows stayed `active`, and the first anyone
 * knew of it was a `401` on a key the credentials page still offered.
 *
 * The rule these tests pin down is fail-closed with an explicit override, and a
 * deliberately narrow idea of what the confirmed change is then allowed to do:
 *
 * - a swap that would lock grantees out is refused with
 *   `409 ACCESS_DISRUPTION_CONFIRMATION_REQUIRED`, and **nothing** moves — not
 *   the row, not the gateway, not the credentials;
 * - the same swap with `confirm_access_disruption: true` goes through, leaves
 *   every grantee's credential alone — it is their consumer's, and it goes on
 *   serving their other APIs of that flavour — revokes only the credentials the
 *   API itself owns, audits what it did, and tells every grantee to issue a
 *   credential of the new flavour;
 * - a swap with nobody to disrupt is unaffected;
 * - a swap the gateway refuses leaves every credential exactly as it was — the
 *   revocation runs last, and only once the swap it follows is durable.
 *
 * Every scenario gets its own client account. Credential material hangs off the
 * *account's* consumer rather than off an API, so a shared client would carry
 * one test's live keys into the next test's reading.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { LightMyRequestResponse } from 'fastify';

import {
  aclGroupForApi,
  consumerUsernameForUser,
  type AccessDisruptionDetails,
  type ApiErrorBody,
  type CreateAccessRequestResponse,
  type CreateTestConsumerResponse,
  type CredentialType,
  type IssueCredentialResponse,
  type ListNotificationsResponse,
  type PublishApiResponse,
  type UpdateApiResponse,
} from '@ferrum-nexus/shared';

import type { AuditLogRecord } from '../db/store.js';
import { buildTestApp, SAMPLE_SPEC_YAML, type TestApp, type TestSession } from './helpers.js';

function errorBody(body: string): ApiErrorBody['error'] {
  return (JSON.parse(body) as ApiErrorBody).error;
}

describe('auth_plugin swaps and the access they disrupt', () => {
  let harness: TestApp;
  let provider: TestSession;
  let clients = 0;

  /** Publish a requestable `key_auth` API owned by `provider`. */
  async function publish(slug: string): Promise<{ id: string; proxyId: string }> {
    const response = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: {
        name: `API ${slug}`,
        slug,
        version: '1.0.0',
        spec: SAMPLE_SPEC_YAML,
        auth_plugin: 'key_auth',
        requestable: true,
        visibility: 'public',
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    const api = response.json<PublishApiResponse>().api;
    const proxyId = (await harness.store.apis.findById(api.id))?.ferrum_proxy_id;
    assert.ok(proxyId, 'a published API always has a gateway proxy');
    return { id: api.id, proxyId };
  }

  /** A client account nothing else in this file has touched. */
  async function newClient(): Promise<TestSession> {
    clients += 1;
    return harness.registerUser({ email: `swap-client-${clients}@example.test`, role: 'client' });
  }

  /** Request access as `client` and approve it as `provider`. */
  async function grant(apiId: string, client: TestSession): Promise<void> {
    const requested = await harness.authed(client, {
      method: 'POST',
      url: '/api/access-requests',
      payload: { api_id: apiId, justification: 'Integration work' },
    });
    assert.equal(requested.statusCode, 201, requested.body);
    const id = requested.json<CreateAccessRequestResponse>().access_request.id;
    const approved = await harness.authed(provider, {
      method: 'POST',
      url: `/api/access-requests/${id}/approve`,
    });
    assert.equal(approved.statusCode, 200, approved.body);
  }

  /** Mint a credential on `session`'s own canonical consumer. */
  async function issue(
    session: TestSession,
    type: CredentialType,
  ): Promise<IssueCredentialResponse> {
    const response = await harness.authed(session, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: type },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<IssueCredentialResponse>();
  }

  /** `PATCH /api/apis/:id` as the owning provider. */
  async function patchApi(
    apiId: string,
    payload: Record<string, unknown>,
  ): Promise<LightMyRequestResponse> {
    return harness.authed(provider, { method: 'PATCH', url: `/api/apis/${apiId}`, payload });
  }

  /** The `api.auth_plugin_changed` summary rows this API has accumulated. */
  async function summaryRows(apiId: string): Promise<AuditLogRecord[]> {
    return (await harness.auditRows('api.auth_plugin_changed')).filter(
      (row) => row.target_id === apiId,
    );
  }

  before(async () => {
    harness = await buildTestApp();
    // The first account registered becomes `super_admin`; the provider must not
    // be it, or ownership and administration stop being distinguishable.
    await harness.registerUser({ email: 'swap-founder@example.test' });
    provider = await harness.registerUser({
      email: 'swap-provider@example.test',
      role: 'provider',
    });
  });

  after(async () => {
    await harness.close();
  });

  it('refuses the swap while grantees depend on the outgoing plugin', async () => {
    const api = await publish('swap-refused');
    const client = await newClient();
    await grant(api.id, client);
    const credential = await issue(client, 'keyauth');

    const response = await patchApi(api.id, { auth_plugin: 'basic_auth' });
    assert.equal(response.statusCode, 409, response.body);
    const error = errorBody(response.body);
    assert.equal(error.code, 'ACCESS_DISRUPTION_CONFIRMATION_REQUIRED');
    assert.deepEqual(error.details as AccessDisruptionDetails, {
      field: 'auth_plugin',
      current_auth_plugin: 'key_auth',
      requested_auth_plugin: 'basic_auth',
      credential_type: 'keyauth',
      affected_grantees: 1,
      confirm_field: 'confirm_access_disruption',
    });
    assert.match(error.message, /would lock 1 account holding access out of it/, error.message);
    assert.match(error.message, /confirm_access_disruption/);

    // Nothing moved: not the row, not the gateway, not the credential.
    assert.equal((await harness.store.apis.findById(api.id))?.auth_plugin, 'key_auth');
    assert.ok(harness.edge.pluginForProxy(api.proxyId, 'key_auth'));
    assert.equal(harness.edge.pluginForProxy(api.proxyId, 'basic_auth'), undefined);
    assert.equal(
      (await harness.store.credentials.findById(credential.credential.id))?.status,
      'active',
    );
    const consumer = harness.edge.consumerByUsername(consumerUsernameForUser(client.user.id));
    assert.equal(consumer?.credentials.keyauth?.length, 1);
    assert.deepEqual(await summaryRows(api.id), []);
  });

  it('revokes the credentials the API owns outright, without asking', async () => {
    const api = await publish('swap-testcon');
    const created = await harness.authed(provider, {
      method: 'POST',
      url: `/api/apis/${api.id}/test-consumer`,
      payload: {},
    });
    assert.equal(created.statusCode, 201, created.body);
    const testCredential = created.json<CreateTestConsumerResponse>().credential;

    // Nobody holds access, so nobody is disrupted and there is nothing to
    // confirm: the only credential in play is the API's own, on a consumer that
    // exists to call this one proxy. The swap really has made it useless.
    const response = await patchApi(api.id, { auth_plugin: 'jwt_auth' });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(
      (await harness.store.credentials.findById(testCredential.id))?.status,
      'revoked',
      'the API revokes the key it owns itself',
    );
    assert.equal(
      harness.edge.consumerByUsername(`nexus-test-${api.id}`)?.credentials.keyauth?.length ?? 0,
      0,
    );

    const revocation = (await harness.auditRows('credential.revoke')).find(
      (row) => row.target_id === testCredential.id,
    );
    assert.ok(revocation, 'the revocation is audited in its own right');
    assert.equal(revocation.details.reason, 'auth_plugin_change');
    assert.equal(revocation.details.api_id, api.id);

    const [summary] = await summaryRows(api.id);
    assert.ok(summary);
    assert.equal(summary.details.affected_grantees, 0);
    assert.equal(summary.details.api_owned_credentials, 1);
    assert.equal(summary.details.revoked_api_credentials, 1);
    assert.deepEqual(summary.details.failed, []);
  });

  it('swaps freely when nothing depends on the outgoing plugin', async () => {
    const api = await publish('swap-unused');
    // A grant with no credential behind it disrupts nobody.
    await grant(api.id, await newClient());

    const response = await patchApi(api.id, { auth_plugin: 'basic_auth' });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json<UpdateApiResponse>().api.auth_plugin, 'basic_auth');
    assert.ok(harness.edge.pluginForProxy(api.proxyId, 'basic_auth'));
    assert.equal(harness.edge.pluginForProxy(api.proxyId, 'key_auth'), undefined);
    assert.deepEqual(
      await summaryRows(api.id),
      [],
      'a swap that disrupted nobody writes no summary row',
    );
  });

  it('leaves grantees their credentials, and tells them to issue a new one', async () => {
    const api = await publish('swap-confirmed');
    // A second `key_auth` API the same account holds access to. The credential
    // below is the *consumer's*, not this API's, and this neighbour is what
    // proves it: revoking it to settle a change on `api` would take down an
    // integration `api`'s provider has no standing over.
    const neighbour = await publish('swap-neighbour');
    const client = await newClient();
    await grant(api.id, client);
    await grant(neighbour.id, client);
    const credential = await issue(client, 'keyauth');

    const response = await patchApi(api.id, {
      auth_plugin: 'basic_auth',
      confirm_access_disruption: true,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json<UpdateApiResponse>().api.auth_plugin, 'basic_auth');

    assert.equal(
      (await harness.store.credentials.findById(credential.credential.id))?.status,
      'active',
      'the grantee keeps the credential; what they lose is this API',
    );
    const consumer = harness.edge.consumerByUsername(consumerUsernameForUser(client.user.id));
    assert.equal(consumer?.credentials.keyauth?.length, 1, 'the entry is still on the gateway');
    // Everything the neighbour needs from that credential is still in place: it
    // still runs `key_auth`, and the consumer still carries its access group.
    assert.ok(harness.edge.pluginForProxy(neighbour.proxyId, 'key_auth'));
    assert.ok(consumer?.acl_groups.includes(aclGroupForApi(neighbour.id)));
    assert.deepEqual(
      (await harness.auditRows('credential.revoke')).filter(
        (row) => row.target_id === credential.credential.id,
      ),
      [],
      'nothing of the grantee’s was revoked, so nothing was logged as revoked',
    );

    const update = (await harness.auditRows('api.update')).find((row) => row.target_id === api.id);
    assert.ok(update);
    assert.equal(update.details.previous_auth_plugin, 'key_auth');
    assert.equal(update.details.existing_credentials_invalidated, true);

    const [summary] = await summaryRows(api.id);
    assert.ok(summary);
    assert.equal(summary.details.affected_grantees, 1);
    assert.deepEqual(summary.details.affected_grantee_ids, [client.user.id]);
    assert.equal(summary.details.previous_credential_type, 'keyauth');
    assert.equal(summary.details.api_owned_credentials, 0);
    assert.equal(summary.details.revoked_api_credentials, 0);
    assert.equal(
      summary.actor_user_id,
      provider.user.id,
      'the provider who made the change is the actor',
    );

    const notifications = await harness.authed(client, {
      method: 'GET',
      url: '/api/notifications?type=system',
    });
    assert.equal(notifications.statusCode, 200, notifications.body);
    const listed = notifications.json<ListNotificationsResponse>().items;
    const announced = listed.find((item) => item.title.includes('authentication method'));
    assert.ok(announced, 'the grantee is told, not left to discover a 401');
    assert.match(announced.body, /basicauth credential/);
    assert.match(announced.body, /still valid for your other APIs/);
    assert.equal(announced.link, '/credentials');
  });

  it('leaves the credentials alone when the gateway refuses the swap', async () => {
    const api = await publish('swap-edge-fails');
    const client = await newClient();
    await grant(api.id, client);
    const credential = await issue(client, 'keyauth');
    const created = await harness.authed(provider, {
      method: 'POST',
      url: `/api/apis/${api.id}/test-consumer`,
      payload: {},
    });
    assert.equal(created.statusCode, 201, created.body);
    const testCredential = created.json<CreateTestConsumerResponse>().credential;

    // The replacement plugin cannot be attached, so the PATCH unwinds. The
    // revocation runs only after the swap is durable, so it must not have run.
    harness.edge.queueFailure(
      500,
      { error: 'edge rejected the plugin' },
      '/plugins/config',
      'POST',
    );
    const response = await patchApi(api.id, {
      auth_plugin: 'jwt_auth',
      confirm_access_disruption: true,
    });
    assert.notEqual(response.statusCode, 200, response.body);

    assert.equal(
      (await harness.store.credentials.findById(testCredential.id))?.status,
      'active',
      'a swap that never landed revokes nothing, not even the API’s own key',
    );
    assert.equal(
      harness.edge.consumerByUsername(`nexus-test-${api.id}`)?.credentials.keyauth?.length,
      1,
    );
    assert.equal(
      (await harness.store.credentials.findById(credential.credential.id))?.status,
      'active',
    );
    const consumer = harness.edge.consumerByUsername(consumerUsernameForUser(client.user.id));
    assert.equal(consumer?.credentials.keyauth?.length, 1);
    assert.equal((await harness.store.apis.findById(api.id))?.auth_plugin, 'key_auth');
    assert.ok(harness.edge.pluginForProxy(api.proxyId, 'key_auth'));
    assert.equal(harness.edge.pluginForProxy(api.proxyId, 'jwt_auth'), undefined);
    assert.deepEqual(await summaryRows(api.id), []);
  });
});
