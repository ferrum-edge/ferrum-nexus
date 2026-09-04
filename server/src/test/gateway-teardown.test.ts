/**
 * Durable gateway revocation for disabled accounts (`GHSA-8vxw-j3wc-w6vm`).
 *
 * The advisory's shape: the portal account goes off, Edge refuses the
 * revocation, Nexus reports success, and the disabled user's API key keeps
 * authenticating against the data plane forever. Every test here is a step of
 * that story with the fix in place — the disable still commits, but the
 * revocation is a committed job, the response says `pending` rather than
 * finished, and the worker keeps trying until Edge confirms it.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  consumerUsernameForUser,
  type ApiErrorBody,
  type GatewayTeardownState,
  type IssueCredentialResponse,
  type User,
} from '@ferrum-nexus/shared';

import { createTeardownWorker, type TeardownWorker } from '../credentials/teardown-worker.js';
import { buildTestApp, type TestApp, type TestSession } from './helpers.js';

/** Give an account a working gateway identity: one API key and one ACL group. */
async function provisionGatewayIdentity(
  harness: TestApp,
  session: TestSession,
): Promise<{ username: string; credentialId: string }> {
  const issued = await harness.authed(session, {
    method: 'POST',
    url: '/api/credentials',
    payload: { credential_type: 'keyauth', label: 'CI' },
  });
  assert.equal(issued.statusCode, 201, issued.body);
  const username = consumerUsernameForUser(session.user.id);
  const consumer = harness.edge.consumerByUsername(username);
  assert.ok(consumer, 'issuing a credential provisioned the consumer');
  consumer.acl_groups = ['nexus:api:some-api:approved'];
  return { username, credentialId: issued.json<IssueCredentialResponse>().credential.id };
}

/** A worker built straight against the store, as a fresh process would build it. */
function workerFor(harness: TestApp): TeardownWorker {
  return createTeardownWorker({
    store: harness.store,
    credentials: harness.services.credentials,
    audit: harness.services.audit,
  });
}

describe('gateway teardown jobs', () => {
  let harness: TestApp;
  /** The first registered account, therefore `super_admin`. */
  let founder: TestSession;
  let admin: TestSession;
  let outsider: TestSession;

  before(async () => {
    harness = await buildTestApp();
    founder = await harness.registerUser({ email: 'teardown-founder@example.test' });
    admin = await harness.registerUser({ email: 'teardown-admin@example.test' });
    outsider = await harness.registerUser({ email: 'teardown-outsider@example.test' });

    const promoted = await harness.authed(founder, {
      method: 'PATCH',
      url: `/api/users/${admin.user.id}`,
      payload: { role: 'admin' },
    });
    assert.equal(promoted.statusCode, 200, promoted.body);
    admin = await harness.loginUser('teardown-admin@example.test');
  });

  after(async () => {
    await harness.close();
  });

  it('queues the revocation and reports pending when the gateway refuses', async () => {
    const target = await harness.registerUser({ email: 'teardown-refused@example.test' });
    const { username, credentialId } = await provisionGatewayIdentity(harness, target);

    harness.edge.queueFailure(500, { error: 'gateway exploded' }, '/consumers');

    const disabled = await harness.authed(founder, {
      method: 'PATCH',
      url: `/api/users/${target.user.id}`,
      payload: { status: 'disabled' },
    });
    assert.equal(disabled.statusCode, 200, disabled.body);
    const body = disabled.json<{ user: User; gateway_teardown?: string }>();
    assert.equal(body.user.status, 'disabled');
    assert.equal(body.gateway_teardown, 'pending', 'the disable is not reported as finished');

    // The portal half committed…
    const stale = await harness.authed(target, { method: 'GET', url: '/api/users/me' });
    assert.equal(stale.statusCode, 401, 'the browser session is gone');

    // …and the gateway half is still owed, on the gateway and in the store.
    const consumer = harness.edge.consumerByUsername(username);
    assert.equal(consumer?.credentials.keyauth?.length, 1, 'the API key is still live on Edge');
    assert.deepEqual(consumer?.acl_groups, ['nexus:api:some-api:approved']);
    assert.equal((await harness.store.credentials.findById(credentialId))?.status, 'active');

    const job = await harness.store.gatewayTeardownJobs.findByUser(target.user.id);
    assert.equal(job?.status, 'pending');
    assert.equal(job?.attempts, 0, 'the failed inline attempt does not consume a claim');
    assert.equal(job?.requested_by, founder.user.id);
  });

  it('the worker finishes the revocation once the gateway recovers', async () => {
    const target = await harness.registerUser({ email: 'teardown-recovers@example.test' });
    const { username, credentialId } = await provisionGatewayIdentity(harness, target);

    harness.edge.queueFailure(500, { error: 'gateway exploded' }, '/consumers');
    const disabled = await harness.authed(founder, {
      method: 'PATCH',
      url: `/api/users/${target.user.id}`,
      payload: { status: 'disabled' },
    });
    assert.equal(disabled.json<{ gateway_teardown?: string }>().gateway_teardown, 'pending');

    // The batch may also carry jobs an earlier case left queued, so the counts
    // are bounds; the per-account assertions below are what this test is about.
    const tick = await harness.services.teardown.tick();
    assert.ok(tick.claimed >= 1);
    assert.ok(tick.completed >= 1);
    assert.equal(tick.rescheduled, 0);

    const consumer = harness.edge.consumerByUsername(username);
    assert.deepEqual(consumer?.credentials, {}, 'every credential type is gone from Edge');
    assert.deepEqual(consumer?.acl_groups, []);
    assert.equal((await harness.store.credentials.findById(credentialId))?.status, 'revoked');

    const job = await harness.store.gatewayTeardownJobs.findByUser(target.user.id);
    assert.equal(job?.status, 'done');
    assert.equal(job?.attempts, 1);
    assert.equal(job?.last_error, null);
    assert.ok(job?.completed_at, 'completion is stamped');

    const completed = (await harness.auditRows('user.gateway_teardown_complete')).find(
      (row) => row.target_id === target.user.id,
    );
    assert.ok(completed, 'the system records the revocation it finished');
    assert.equal(completed?.actor_user_id, null, 'the actor is the system, not an admin');
    assert.equal(completed?.details.gateway_teardown, 'ok');
    assert.equal(completed?.details.revoked_credentials, 1);
    assert.deepEqual(completed?.details.removed_acl_groups, ['nexus:api:some-api:approved']);
  });

  it('a queued revocation survives a restart', async () => {
    const target = await harness.registerUser({ email: 'teardown-restart@example.test' });
    const { username } = await provisionGatewayIdentity(harness, target);

    harness.edge.queueFailure(500, { error: 'gateway exploded' }, '/consumers');
    await harness.authed(founder, {
      method: 'PATCH',
      url: `/api/users/${target.user.id}`,
      payload: { status: 'disabled' },
    });
    assert.equal(
      (await harness.store.gatewayTeardownJobs.findByUser(target.user.id))?.status,
      'pending',
    );

    // A brand-new worker over the same store is what a restarted process has:
    // no in-memory state, only the committed job.
    const restarted = workerFor(harness);
    const tick = await restarted.tick();
    assert.equal(tick.completed, 1);

    assert.deepEqual(harness.edge.consumerByUsername(username)?.credentials, {});
    assert.equal(
      (await harness.store.gatewayTeardownJobs.findByUser(target.user.id))?.status,
      'done',
    );
  });

  it('reschedules with a backoff while the gateway stays down', async () => {
    const target = await harness.registerUser({ email: 'teardown-backoff@example.test' });
    const { username } = await provisionGatewayIdentity(harness, target);

    // Two injected failures: one for the inline attempt, one for the worker's.
    harness.edge.queueFailure(500, { error: 'still down' }, '/consumers');
    harness.edge.queueFailure(500, { error: 'still down' }, '/consumers');
    await harness.authed(founder, {
      method: 'PATCH',
      url: `/api/users/${target.user.id}`,
      payload: { status: 'disabled' },
    });

    const tick = await harness.services.teardown.tick();
    assert.equal(tick.claimed, 1);
    assert.equal(tick.rescheduled, 1);
    assert.equal(tick.completed, 0);

    const job = await harness.store.gatewayTeardownJobs.findByUser(target.user.id);
    assert.equal(job?.status, 'pending', 'a failure is a retry, never a terminal state');
    assert.equal(job?.attempts, 1);
    assert.ok((job?.last_error ?? '').length > 0, 'the reason is kept for the admin surface');
    assert.ok((job?.next_attempt_at ?? '') > new Date().toISOString(), 'the retry is backed off');
    assert.equal(harness.edge.consumerByUsername(username)?.credentials.keyauth?.length, 1);
  });

  it('re-enabling an account cancels its queued revocation', async () => {
    const target = await harness.registerUser({ email: 'teardown-reenabled@example.test' });
    const { username } = await provisionGatewayIdentity(harness, target);

    harness.edge.queueFailure(500, { error: 'gateway exploded' }, '/consumers');
    await harness.authed(founder, {
      method: 'PATCH',
      url: `/api/users/${target.user.id}`,
      payload: { status: 'disabled' },
    });
    assert.ok(await harness.store.gatewayTeardownJobs.findByUser(target.user.id));

    const reenabled = await harness.authed(founder, {
      method: 'PATCH',
      url: `/api/users/${target.user.id}`,
      payload: { status: 'active' },
    });
    assert.equal(reenabled.statusCode, 200, reenabled.body);
    assert.equal(
      await harness.store.gatewayTeardownJobs.findByUser(target.user.id),
      null,
      'a retry must never strip a live account',
    );

    const tick = await harness.services.teardown.tick();
    assert.equal(tick.claimed, 0);
    assert.equal(harness.edge.consumerByUsername(username)?.credentials.keyauth?.length, 1);
  });

  it('drops a job whose account was re-enabled behind the worker', async () => {
    const target = await harness.registerUser({ email: 'teardown-raced@example.test' });
    const { username } = await provisionGatewayIdentity(harness, target);

    harness.edge.queueFailure(500, { error: 'gateway exploded' }, '/consumers');
    await harness.authed(founder, {
      method: 'PATCH',
      url: `/api/users/${target.user.id}`,
      payload: { status: 'disabled' },
    });
    // Flip the account back on without going through the service, so the job is
    // left behind exactly as a racing re-enable would leave it.
    await harness.store.users.update(target.user.id, { status: 'active' });

    const tick = await harness.services.teardown.tick();
    assert.equal(tick.claimed, 1);
    assert.equal(tick.cancelled, 1);
    assert.equal(tick.completed, 0);
    assert.equal(await harness.store.gatewayTeardownJobs.findByUser(target.user.id), null);
    assert.equal(harness.edge.consumerByUsername(username)?.credentials.keyauth?.length, 1);
  });

  it('god-mode disable queues the same durable job', async () => {
    const target = await harness.registerUser({ email: 'teardown-god@example.test' });
    const { username, credentialId } = await provisionGatewayIdentity(harness, target);

    harness.edge.queueFailure(500, { error: 'gateway exploded' }, '/consumers');
    const disabled = await harness.authed(founder, {
      method: 'POST',
      url: '/api/admin/god/disable-user',
      payload: { user_id: target.user.id, reason: 'Key posted to a public repo.' },
    });
    assert.equal(disabled.statusCode, 200, disabled.body);
    assert.equal(disabled.json<{ gateway_teardown: string }>().gateway_teardown, 'pending');

    const godRow = (await harness.auditRows('god.disable_user')).find(
      (row) => row.target_id === target.user.id,
    );
    assert.equal(godRow?.details.gateway_teardown, 'pending');
    assert.equal(
      (await harness.store.gatewayTeardownJobs.findByUser(target.user.id))?.status,
      'pending',
    );

    await harness.services.teardown.tick();
    assert.deepEqual(harness.edge.consumerByUsername(username)?.credentials, {});
    assert.equal((await harness.store.credentials.findById(credentialId))?.status, 'revoked');
  });

  it('exposes the pending state on the admin user detail and list', async () => {
    const target = await harness.registerUser({ email: 'teardown-detail@example.test' });
    await provisionGatewayIdentity(harness, target);

    harness.edge.queueFailure(500, { error: 'gateway exploded' }, '/consumers');
    await harness.authed(founder, {
      method: 'PATCH',
      url: `/api/users/${target.user.id}`,
      payload: { status: 'disabled' },
    });

    const detail = await harness.authed(admin, {
      method: 'GET',
      url: `/api/users/${target.user.id}`,
    });
    assert.equal(detail.statusCode, 200, detail.body);
    const teardown = detail.json<{ gateway_teardown: GatewayTeardownState | null }>()
      .gateway_teardown;
    assert.equal(teardown?.status, 'pending');
    assert.equal(teardown?.completed_at, null);

    const list = await harness.authed(admin, { method: 'GET', url: '/api/users' });
    assert.equal(list.statusCode, 200, list.body);
    assert.ok(
      list.json<{ pending_gateway_teardowns: number }>().pending_gateway_teardowns >= 1,
      'the admin list carries the portal-wide backlog',
    );

    const refused = await harness.authed(outsider, {
      method: 'GET',
      url: `/api/users/${target.user.id}`,
    });
    assert.equal(refused.statusCode, 403);
  });

  it('retries on demand, and only for an admin on a disabled account', async () => {
    const target = await harness.registerUser({ email: 'teardown-retry@example.test' });
    const { username, credentialId } = await provisionGatewayIdentity(harness, target);

    harness.edge.queueFailure(500, { error: 'gateway exploded' }, '/consumers');
    await harness.authed(founder, {
      method: 'PATCH',
      url: `/api/users/${target.user.id}`,
      payload: { status: 'disabled' },
    });

    const refused = await harness.authed(outsider, {
      method: 'POST',
      url: `/api/users/${target.user.id}/gateway-teardown/retry`,
    });
    assert.equal(refused.statusCode, 403, 'the retry is an admin action');

    const retried = await harness.authed(admin, {
      method: 'POST',
      url: `/api/users/${target.user.id}/gateway-teardown/retry`,
    });
    assert.equal(retried.statusCode, 200, retried.body);
    const result = retried.json<{ gateway_teardown: string; job: GatewayTeardownState | null }>();
    assert.equal(result.gateway_teardown, 'ok');
    assert.equal(result.job?.status, 'done');

    assert.deepEqual(harness.edge.consumerByUsername(username)?.credentials, {});
    assert.equal((await harness.store.credentials.findById(credentialId))?.status, 'revoked');

    const audited = (await harness.auditRows('user.gateway_teardown_retry')).find(
      (row) => row.target_id === target.user.id,
    );
    assert.equal(audited?.details.gateway_teardown, 'ok');
    assert.equal(audited?.actor_user_id, admin.user.id);

    // An active account has nothing to revoke, so the retry is refused rather
    // than quietly stripping a working consumer.
    const active = await harness.registerUser({ email: 'teardown-active@example.test' });
    const conflict = await harness.authed(admin, {
      method: 'POST',
      url: `/api/users/${active.user.id}/gateway-teardown/retry`,
    });
    assert.equal(conflict.statusCode, 409, conflict.body);
    assert.equal((JSON.parse(conflict.body) as ApiErrorBody).error.code, 'CONFLICT');
  });
});
