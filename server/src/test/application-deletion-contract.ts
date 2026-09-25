/**
 * Deleting an application, against every adapter — issues #363, #364 and
 * #365.
 *
 * Three defects met at one operation:
 *
 * - **#363.** The rolling access-request budget counted `access_requests`
 *   rows, and deleting an application cascades its requests away — so create
 *   application → request → delete → repeat handed the account its allowance
 *   back every time. The charge is now the requester's `access.request` audit
 *   row, written in the request's own transaction.
 * - **#364.** MongoDB has no foreign keys, so its adapter stands in for the SQL
 *   cascade with one `deleteMany` per scoped collection, and ran them as loose
 *   writes: a failure part-way left some collections emptied and the
 *   application still standing. The cascade is one transaction now, and the
 *   service's counts and delete share one too.
 * - **#365.** A request resolved its application in the route, before the
 *   access service took any lock, so a delete that finished in between left
 *   MongoDB holding a pending request for an application that no longer
 *   existed. Filing an application-scoped request now holds the provisioning
 *   name key the delete holds, and re-reads the application inside it.
 *
 * Every case runs through the real routes and services, over each adapter's
 * store, because the defects live in how the service and the adapter fit
 * together rather than in either alone.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { LightMyRequestResponse } from 'fastify';
import { Collection } from 'mongodb';

import {
  consumerUsernameForApplication,
  type ApiErrorBody,
  type CreateAccessRequestResponse,
  type CreateApplicationResponse,
  type PublishApiResponse,
} from '@ferrum-nexus/shared';

import { AuditAction } from '../audit/service.js';
import { canonicalConsumerLockKey } from '../credentials/consumers.js';
import type { NexusStore } from '../db/store.js';
import { isoInSeconds } from '../lib/ids.js';
import { buildTestApp, SAMPLE_SPEC_YAML, type TestApp, type TestSession } from './helpers.js';

/** One request a day, so a single refund is visible. */
const ENV = { NEXUS_MAX_ACCESS_REQUESTS_PER_USER_PER_DAY: '1' };

const NAMESPACE = 'nexus';

/** What a target must offer for this contract to run. */
export interface ApplicationDeletionTarget {
  store: NexusStore;
  teardown: () => Promise<void>;
}

/** A gate one side of a race waits on until the test opens it. */
function barrier(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** The real application and access routes over one adapter's store. */
export function runApplicationDeletionContract(
  label: string,
  makeStore: () => Promise<ApplicationDeletionTarget>,
): void {
  describe(`application deletion contract — ${label}`, () => {
    let target: ApplicationDeletionTarget;
    let harness: TestApp;
    let provider: TestSession;
    let apiX: string;
    let apiY: string;
    let names = 0;

    before(async () => {
      target = await makeStore();
      harness = await buildTestApp({
        store: target.store,
        env: ENV,
        deps: { startOutboxWorker: false },
      });
      await harness.registerUser();
      provider = await harness.registerUser({ role: 'provider' });
      apiX = await publish('deletion-contract-x');
      apiY = await publish('deletion-contract-y');
    });

    after(async () => {
      await harness?.close();
      await target?.teardown();
    });

    async function publish(slug: string): Promise<string> {
      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: {
          name: `API ${slug}`,
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

    async function createApplication(session: TestSession): Promise<string> {
      names += 1;
      const response = await harness.authed(session, {
        method: 'POST',
        url: '/api/applications',
        payload: { name: `Deletion ${names}` },
      });
      assert.equal(response.statusCode, 201, response.body);
      return response.json<CreateApplicationResponse>().application.id;
    }

    function requestAccess(
      session: TestSession,
      apiId: string,
      applicationId: string | null,
    ): Promise<LightMyRequestResponse> {
      return harness.authed(session, {
        method: 'POST',
        url: '/api/access-requests',
        payload: {
          api_id: apiId,
          justification: 'Integration access',
          ...(applicationId === null ? {} : { application_id: applicationId }),
        },
      });
    }

    function deleteApplication(
      session: TestSession,
      applicationId: string,
    ): Promise<LightMyRequestResponse> {
      return harness.authed(session, {
        method: 'DELETE',
        url: `/api/applications/${applicationId}`,
      });
    }

    function errorCode(body: string): string {
      return (JSON.parse(body) as ApiErrorBody).error.code;
    }

    /** The budget's charges for one account: its `access.request` rows. */
    function charges(userId: string): Promise<number> {
      return target.store.auditLogs.count({
        actor_user_id: userId,
        action: AuditAction.ACCESS_REQUEST,
      });
    }

    /** A charge written as though a request had been filed at `createdAt`. */
    async function charge(session: TestSession, createdAt: string): Promise<void> {
      await target.store.auditLogs.create({
        actor_user_id: session.user.id,
        actor_role: 'client',
        action: AuditAction.ACCESS_REQUEST,
        target_type: 'access_request',
        target_id: null,
        details: {},
        ip: null,
        created_at: createdAt,
      });
    }

    /** Every row the application's cascade is responsible for. */
    async function scopedRows(applicationId: string): Promise<Record<string, number>> {
      const store = target.store;
      return {
        grants: (await store.grants.list({ application_id: applicationId })).total,
        requests: (await store.accessRequests.list({ application_id: applicationId })).total,
        credentials: (await store.credentials.list({ application_id: applicationId })).total,
        consumers: (await store.consumers.list({ application_id: applicationId })).total,
      };
    }

    /**
     * An application holding one of everything the cascade removes: an
     * approved request, its grant, the consumer mapping and a credential.
     */
    async function provisionedApplication(owner: TestSession): Promise<string> {
      const applicationId = await createApplication(owner);
      const requested = await requestAccess(owner, apiX, applicationId);
      assert.equal(requested.statusCode, 201, requested.body);
      const requestId = requested.json<CreateAccessRequestResponse>().access_request.id;
      const approved = await harness.authed(provider, {
        method: 'POST',
        url: `/api/access-requests/${requestId}/approve`,
        payload: {},
      });
      assert.equal(approved.statusCode, 200, approved.body);
      const issued = await harness.authed(owner, {
        method: 'POST',
        url: '/api/credentials',
        payload: { credential_type: 'keyauth', application_id: applicationId },
      });
      assert.equal(issued.statusCode, 201, issued.body);
      assert.deepEqual(await scopedRows(applicationId), {
        grants: 1,
        requests: 1,
        credentials: 1,
        consumers: 1,
      });
      return applicationId;
    }

    /* ── #363: the budget survives the deletion ───────────────────────── */

    it('keeps a deleted application’s request charged to the account', async () => {
      const client = await harness.registerUser();
      const first = await createApplication(client);
      const spent = await requestAccess(client, apiX, first);
      assert.equal(spent.statusCode, 201, spent.body);

      const deleted = await deleteApplication(client, first);
      assert.equal(deleted.statusCode, 200, deleted.body);
      assert.equal(
        (await target.store.accessRequests.list({ user_id: client.user.id })).total,
        0,
        'the cascade took the request row',
      );
      assert.equal(await charges(client.user.id), 1, 'but not the charge');

      const second = await createApplication(client);
      const refused = await requestAccess(client, apiX, second);
      assert.equal(refused.statusCode, 429, refused.body);
      assert.equal(errorCode(refused.body), 'QUOTA_EXCEEDED');
      const account = await requestAccess(client, apiY, null);
      assert.equal(account.statusCode, 429, 'the budget is the account’s, whatever the identity');
      assert.equal(await charges(client.user.id), 1, 'a refusal charges nothing');
    });

    it('charges nothing for a request that rolls back', async (t) => {
      const client = await harness.registerUser();
      const failure = new Error('injected audit failure');
      const originalTransaction = target.store.transaction.bind(target.store);
      // The charge and the request share one transaction: failing the charge
      // must take the request with it, and leave the allowance unspent.
      const transaction = t.mock.method(
        target.store,
        'transaction',
        async <T>(fn: (tx: NexusStore) => Promise<T>): Promise<T> =>
          originalTransaction((tx) =>
            fn(
              new Proxy(tx, {
                get(scoped, property, receiver) {
                  if (property === 'auditLogs') {
                    return {
                      ...scoped.auditLogs,
                      create: async (): Promise<never> => {
                        throw failure;
                      },
                    };
                  }
                  return Reflect.get(scoped, property, receiver);
                },
              }),
            ),
          ),
      );
      const failed = await requestAccess(client, apiX, null);
      transaction.mock.restore();
      assert.equal(failed.statusCode, 500, failed.body);
      assert.equal(
        (await target.store.accessRequests.list({ user_id: client.user.id })).total,
        0,
        'the request rolled back with its charge',
      );
      assert.equal(await charges(client.user.id), 0);

      const accepted = await requestAccess(client, apiX, null);
      assert.equal(accepted.statusCode, 201, 'the allowance was never spent');
      const refused = await requestAccess(client, apiY, null);
      assert.equal(refused.statusCode, 429, 'and the successful one did spend it');
    });

    it('lets a charge age out of the rolling window', async () => {
      const aged = await harness.registerUser();
      const recent = await harness.registerUser();
      await charge(aged, isoInSeconds(-25 * 60 * 60));
      await charge(recent, isoInSeconds(-23 * 60 * 60));
      assert.equal((await requestAccess(aged, apiX, null)).statusCode, 201);
      assert.equal((await requestAccess(recent, apiX, null)).statusCode, 429);
    });

    /* ── #365: request creation against deletion ─────────────────────── */

    it('refuses a request whose application was deleted after the route resolved it', async () => {
      const client = await harness.registerUser();
      const applicationId = await createApplication(client);
      const notices = (await target.store.notifications.list({ user_id: provider.user.id })).total;

      // Hold the request between the route's resolution and the access
      // service, and delete the application there.
      const applications = harness.services.applications;
      const resolveForActor = applications.resolveForActor;
      const resolved = barrier();
      const proceed = barrier();
      applications.resolveForActor = async (actor, id) => {
        const application = await resolveForActor.call(applications, actor, id);
        resolved.release();
        await proceed.promise;
        return application;
      };
      try {
        const pending = requestAccess(client, apiX, applicationId);
        await resolved.promise;
        const deleted = await deleteApplication(client, applicationId);
        assert.equal(deleted.statusCode, 200, deleted.body);
        proceed.release();

        const stale = await pending;
        assert.equal(stale.statusCode, 404, stale.body);
        assert.equal(errorCode(stale.body), 'NOT_FOUND');
      } finally {
        applications.resolveForActor = resolveForActor;
        proceed.release();
      }

      assert.equal(
        (await target.store.accessRequests.list({ user_id: client.user.id })).total,
        0,
        'no request survives for the deleted application',
      );
      assert.equal(await charges(client.user.id), 0, 'no charge and no access.request row');
      assert.equal(
        (await target.store.notifications.list({ user_id: provider.user.id })).total,
        notices,
        'and no provider notice',
      );
      const account = await requestAccess(client, apiX, null);
      assert.equal(account.statusCode, 201, 'the refused request spent no allowance');
    });

    it('cascades a request that committed before the delete took the key', async () => {
      const client = await harness.registerUser();
      const applicationId = await createApplication(client);
      const key = canonicalConsumerLockKey(
        NAMESPACE,
        consumerUsernameForApplication(applicationId),
      );

      // Hold the request after it committed, before it lets go of the key,
      // and start the delete there.
      const notifications = harness.services.notifications;
      const notify = notifications.notify;
      const committed = barrier();
      const proceed = barrier();
      notifications.notify = async (userId, type, title, body, link) => {
        if (type === 'access_request_created') {
          committed.release();
          await proceed.promise;
        }
        return notify.call(notifications, userId, type, title, body, link);
      };
      const edge = harness.edgeClient;
      const serializePerKey = edge.serializePerKey;
      const queued = barrier();
      let arrivals = 0;
      edge.serializePerKey = (candidate, work) => {
        if (candidate === key && ++arrivals === 2) queued.release();
        return serializePerKey(candidate, work);
      };
      try {
        const requested = requestAccess(client, apiX, applicationId);
        await committed.promise;
        const deletion = deleteApplication(client, applicationId);
        await Promise.race([queued.promise, deletion]);
        assert.ok(
          await target.store.applications.findById(applicationId),
          'the delete waits for the request holding the application’s key',
        );
        proceed.release();

        const [created, deleted] = await Promise.all([requested, deletion]);
        assert.equal(created.statusCode, 201, created.body);
        assert.equal(deleted.statusCode, 200, deleted.body);
      } finally {
        notifications.notify = notify;
        edge.serializePerKey = serializePerKey;
        proceed.release();
      }

      assert.equal(await target.store.applications.findById(applicationId), null);
      assert.equal(
        (await target.store.accessRequests.list({ user_id: client.user.id })).total,
        0,
        'the delete that followed took the request with it',
      );
      assert.equal(await charges(client.user.id), 1, 'and the request stays charged');
    });

    /* ── #364: the local cascade is all-or-nothing ───────────────────── */

    it('rolls the whole local delete back when it fails, and a retry finishes it', async (t) => {
      const owner = await harness.registerUser();
      const applicationId = await provisionedApplication(owner);
      const username = consumerUsernameForApplication(applicationId);
      assert.ok(harness.edge.consumerByUsername(username, NAMESPACE));

      // Fail straight after the cascade ran, inside the service's transaction:
      // everything it removed has to come back.
      const failure = new Error('injected failure after the cascade');
      const originalTransaction = target.store.transaction.bind(target.store);
      const transaction = t.mock.method(
        target.store,
        'transaction',
        async <T>(fn: (tx: NexusStore) => Promise<T>): Promise<T> =>
          originalTransaction((tx) =>
            fn(
              new Proxy(tx, {
                get(scoped, property, receiver) {
                  if (property === 'applications') {
                    return {
                      ...scoped.applications,
                      delete: async (id: string): Promise<boolean> => {
                        await scoped.applications.delete(id);
                        throw failure;
                      },
                    };
                  }
                  return Reflect.get(scoped, property, receiver);
                },
              }),
            ),
          ),
      );
      const failed = await deleteApplication(owner, applicationId);
      transaction.mock.restore();
      assert.equal(failed.statusCode, 500, failed.body);
      assert.ok(await target.store.applications.findById(applicationId));
      assert.deepEqual(
        await scopedRows(applicationId),
        { grants: 1, requests: 1, credentials: 1, consumers: 1 },
        'the cascade rolled back with the row',
      );
      assert.equal(
        harness.edge.consumerByUsername(username, NAMESPACE),
        undefined,
        'the gateway delete, which went first, is not undone',
      );

      const retried = await deleteApplication(owner, applicationId);
      assert.equal(retried.statusCode, 200, retried.body);
      assert.deepEqual(retried.json<{ revoked_grants: number; revoked_credentials: number }>(), {
        revoked_grants: 1,
        revoked_credentials: 1,
      });
      assert.equal(await target.store.applications.findById(applicationId), null);
      assert.deepEqual(await scopedRows(applicationId), {
        grants: 0,
        requests: 0,
        credentials: 0,
        consumers: 0,
      });
      assert.equal(
        harness.edge.consumerByUsername(username, NAMESPACE),
        undefined,
        'the retry recreated no gateway identity',
      );
    });

    it('keeps MongoDB’s per-collection cascade atomic', async (t) => {
      // The SQL cascade is one `DELETE` the database applies atomically; only
      // MongoDB spells it out as one write per collection.
      if (target.store.driver !== 'mongodb') {
        return t.skip('the SQL cascade is a single statement');
      }
      const owner = await harness.registerUser();
      const applicationId = await provisionedApplication(owner);

      // Every scoped collection's `deleteMany` succeeds; the application's
      // own `deleteOne`, the last write, does not.
      const failure = new Error('injected failure deleting the application document');
      type DeleteOne = (this: Collection, ...args: unknown[]) => Promise<unknown>;
      const prototype = Collection.prototype as unknown as { deleteOne: DeleteOne };
      const deleteOne = prototype.deleteOne;
      prototype.deleteOne = function (this: Collection, ...args: unknown[]): Promise<unknown> {
        if (this.collectionName === 'applications') return Promise.reject(failure);
        return deleteOne.apply(this, args);
      };
      try {
        await assert.rejects(target.store.applications.delete(applicationId));
        assert.deepEqual(
          await scopedRows(applicationId),
          { grants: 1, requests: 1, credentials: 1, consumers: 1 },
          'the repository call on its own is atomic',
        );

        const failed = await deleteApplication(owner, applicationId);
        assert.equal(failed.statusCode, 500, failed.body);
        assert.deepEqual(
          await scopedRows(applicationId),
          { grants: 1, requests: 1, credentials: 1, consumers: 1 },
          'and so is the service path',
        );
        assert.ok(await target.store.applications.findById(applicationId));
      } finally {
        prototype.deleteOne = deleteOne;
      }

      const retried = await deleteApplication(owner, applicationId);
      assert.equal(retried.statusCode, 200, retried.body);
      assert.deepEqual(retried.json<{ revoked_grants: number; revoked_credentials: number }>(), {
        revoked_grants: 1,
        revoked_credentials: 1,
      });
      assert.deepEqual(await scopedRows(applicationId), {
        grants: 0,
        requests: 0,
        credentials: 0,
        consumers: 0,
      });
    });
  });
}
