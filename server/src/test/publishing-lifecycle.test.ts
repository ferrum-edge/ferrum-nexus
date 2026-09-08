/**
 * The two lifecycle failures that can take an API off the gateway — or leave
 * one on it — without the portal saying so.
 *
 * Both are the same invariant from opposite ends: the portal and the gateway
 * either both have the API, or neither does.
 *
 * - **Deleting an API while its enforcement mode is converting** (issue #135).
 *   A conversion is a delete-and-recreate, so a teardown that took no proxy
 *   lease could commit — rows and all — in the middle of one and leave the
 *   conversion's rebuild as the last writer to touch the gateway: a live proxy
 *   fronting the provider's upstream with no portal record, nothing in the
 *   product able to remove it, and a slug burned for good. The lease is what
 *   stops that; the conversion's own "does the portal still describe this API?"
 *   check is the backstop for what a lease cannot fence, and is exercised here
 *   too, in both the forward and the rollback direction.
 * - **A rollback of a *successful* conversion that cannot rebuild** (issue
 *   #141). The undo step the conversion returns runs the same destructive
 *   restore as the forward path, and the caller's compensation loop swallows
 *   what an undo step throws — so without a record of its own the proxy
 *   vanishes while the row still reads `published`, and nothing anywhere says
 *   the API is off the air.
 */

import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import type { GetApiResponse, PublishApiResponse } from '@ferrum-nexus/shared';

import type { ApiRecord } from '../db/store.js';
import { faultInjectingStore, type FaultInjectingStore } from './fault-injection.js';
import { SAMPLE_SPEC_YAML, buildTestApp, type TestApp, type TestSession } from './helpers.js';

/** Body of `POST /api/apis` for an API with a proxy, an auth plugin and an ACL. */
function publishPayload(
  slug: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: `Lifecycle ${slug}`,
    slug,
    version: '2.4.0',
    spec: SAMPLE_SPEC_YAML,
    auth_plugin: 'key_auth',
    requestable: true,
    visibility: 'public',
    ...overrides,
  };
}

/** The `details` of every `api.gateway_repair_required` row an API accumulated. */
async function repairRows(app: TestApp, apiId: string): Promise<Record<string, unknown>[]> {
  const rows = await app.auditRows('api.gateway_repair_required');
  return rows.filter((row) => row.target_id === apiId).map((row) => row.details);
}

/**
 * A one-shot barrier over one Edge client call.
 *
 * {@link Barrier.block} is what the patched method awaits: it announces that
 * the call has arrived and then parks until the test releases it. That is the
 * difference between this and a timed delay — the test knows the first
 * operation is *inside* its lease rather than hoping 400 ms was longer than
 * 120 ms, so the interleaving under assertion is the one that actually ran.
 */
interface Barrier {
  /** Resolves once the patched call has been reached. */
  arrived: Promise<void>;
  /** Awaited by the patched call; resolves when {@link Barrier.release} runs. */
  block: () => Promise<void>;
  /** Lets the held call proceed. Safe to call twice. */
  release: () => void;
}

/** A fresh {@link Barrier}. */
function barrier(): Barrier {
  let announce = (): void => {};
  const arrived = new Promise<void>((resolve) => {
    announce = resolve;
  });
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    arrived,
    block: async () => {
      announce();
      await held;
    },
    release: () => release(),
  };
}

describe('deleting an API that races an enforcement conversion', () => {
  let harness: TestApp;
  let provider: TestSession;

  before(async () => {
    harness = await buildTestApp();
    await harness.registerUser({ email: 'lifecycle-founder@example.test' });
    provider = await harness.registerUser({
      email: 'lifecycle-provider@example.test',
      role: 'provider',
    });
  });

  after(async () => {
    await harness.close();
  });

  /** Undo the patches a test installed, whether or not it reached its own. */
  const cleanups: (() => void)[] = [];

  // Both injections are one-shot *and* matched, so one a test armed but never
  // met would stay armed and fire inside the next test instead.
  afterEach(() => {
    harness.edge.clearInjections();
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  /**
   * Publish an API, then run a `DELETE` and a `PATCH {spec_enforcement}`
   * against it under a forced interleaving, and assert the two sides agree.
   *
   * Nothing here is timed. `hold` parks one gateway call of the operation that
   * starts first, so it is provably *inside* the proxy lease; the second
   * operation is started only once that call has arrived, and released only
   * once it has been seen asking for `proxy:<id>` — which is the claim issue
   * #135's fix makes, and the thing a `setTimeout` stagger could only hope for.
   *
   * The end state is the assertion. Whichever operation wins, the gateway must
   * not be left serving an API the portal has no row for.
   *
   * @param hold patches one Edge client call to await `block`, and returns the
   * undo for that patch
   */
  async function assertRaceLeavesNothingOrphaned(
    slug: string,
    deleteFirst: boolean,
    hold: (block: () => Promise<void>) => () => void,
  ): Promise<void> {
    const published = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: publishPayload(slug),
    });
    assert.equal(published.statusCode, 201, published.body);
    const api = published.json<PublishApiResponse>().api;
    const proxyId = String(api.ferrum_proxy_id);
    const listenPath = `/nexus/${slug}`;
    assert.ok(harness.edge.proxyServing(listenPath), 'the API is live before the race');

    const remove = () => harness.authed(provider, { method: 'DELETE', url: `/api/apis/${api.id}` });
    const convert = () =>
      harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${api.id}`,
        payload: { spec_enforcement: 'routes' },
      });

    const gate = barrier();
    cleanups.push(gate.release, hold(gate.block));
    // The second operation's own lease request is the proof it contended: both
    // take `proxy:<id>` through `binder.withProxy`, so the second call for that
    // key is the one queued behind the held operation.
    let waiting = (): void => {};
    const contending = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    const serialize = harness.edgeClient.serializePerKey.bind(harness.edgeClient);
    cleanups.push(() => {
      harness.edgeClient.serializePerKey = serialize;
    });
    let requests = 0;
    harness.edgeClient.serializePerKey = (key, fn) => {
      if (key === `proxy:${proxyId}`) {
        requests += 1;
        if (requests === 2) waiting();
      }
      return serialize(key, fn);
    };

    const first = deleteFirst ? remove() : convert();
    await gate.arrived;
    const second = deleteFirst ? convert() : remove();
    await contending;
    gate.release();
    const responses = await Promise.all([first, second]);

    // The delete wins in both orderings, and the interleaving decides only how
    // the conversion is refused: it either ran to completion first and the
    // teardown followed it, or it woke behind the teardown to find no row left
    // to convert. What must never happen is the third outcome — rows gone,
    // proxy back.
    const removed = deleteFirst ? responses[0] : responses[1];
    const converted = deleteFirst ? responses[1] : responses[0];
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal(converted.statusCode, deleteFirst ? 404 : 200, converted.body);

    const reread = await harness.authed(provider, { method: 'GET', url: `/api/apis/${api.id}` });
    assert.equal(reread.statusCode, 404, reread.body);
    assert.equal(
      harness.edge.proxyServing(listenPath),
      undefined,
      'nothing is left serving the deleted API',
    );
    assert.equal(
      harness.edge.proxies.get(`nexus/${proxyId}`),
      undefined,
      'no proxy survived under the API id, on the listen path or a staging one',
    );
    assert.equal(harness.edge.apiSpecForProxy(proxyId), undefined, 'no api_spec survived');
    assert.equal(harness.edge.pluginsForProxy(proxyId).length, 0, 'no plugin config survived');
    assert.equal(
      (await harness.auditRows('api.delete')).filter((row) => row.target_id === api.id).length,
      1,
      'exactly one api.delete row, written because the teardown held',
    );

    // And the slug is not burned: republishing it works, which it cannot do
    // while a proxy named `nexus-<slug>` is still on the gateway.
    const republished = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: publishPayload(slug),
    });
    assert.equal(republished.statusCode, 201, republished.body);
    assert.ok(harness.edge.proxyServing(listenPath), 'the republished API is live');
    await harness.authed(provider, {
      method: 'DELETE',
      url: `/api/apis/${republished.json<PublishApiResponse>().api.id}`,
    });
  }

  it('leaves nothing serving if a delete lands mid-conversion', { timeout: 20_000 }, async () => {
    // The conversion is held inside its lease at the point routes mode creates
    // the spec-owned proxy — the window the delete used to run straight
    // through, because `remove()` took no lease at all.
    await assertRaceLeavesNothingOrphaned('race-convert-first', false, (block) => {
      const real = harness.edgeClient.apiSpecs.create.bind(harness.edgeClient.apiSpecs);
      harness.edgeClient.apiSpecs.create = async (...args) => {
        harness.edgeClient.apiSpecs.create = real;
        await block();
        return real(...args);
      };
      return () => {
        harness.edgeClient.apiSpecs.create = real;
      };
    });
  });

  it('leaves nothing serving if a conversion lands mid-delete', { timeout: 20_000 }, async () => {
    // The mirror image: the teardown is held inside its lease at the proxy
    // delete, so the conversion arrives while the rows are still there and has
    // to wait rather than rebuild against a row that is being removed.
    await assertRaceLeavesNothingOrphaned('race-delete-first', true, (block) => {
      const real = harness.edgeClient.proxies.delete.bind(harness.edgeClient.proxies);
      harness.edgeClient.proxies.delete = async (...args) => {
        harness.edgeClient.proxies.delete = real;
        await block();
        return real(...args);
      };
      return () => {
        harness.edgeClient.proxies.delete = real;
      };
    });
  });

  it('still cascades the spec and the validator on an ordinary routes delete', async () => {
    // The negative: taking the lease must not change what a plain delete does.
    const published = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: publishPayload('lifecycle-plain', { spec_enforcement: 'routes' }),
    });
    assert.equal(published.statusCode, 201, published.body);
    const api = published.json<PublishApiResponse>().api;
    const proxyId = String(api.ferrum_proxy_id);
    assert.ok(harness.edge.apiSpecForProxy(proxyId), 'routes mode imported a spec');
    assert.ok(harness.edge.pluginForProxy(proxyId, 'openapi_validator'));

    const removed = await harness.authed(provider, {
      method: 'DELETE',
      url: `/api/apis/${api.id}`,
    });
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal(harness.edge.proxyServing('/nexus/lifecycle-plain'), undefined);
    assert.equal(harness.edge.apiSpecForProxy(proxyId), undefined);
    assert.equal(harness.edge.pluginsForProxy(proxyId).length, 0);
  });

  it('refuses the delete when the proxy identity moved while it waited', async () => {
    const published = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: publishPayload('lifecycle-moved'),
    });
    assert.equal(published.statusCode, 201, published.body);
    const api = published.json<PublishApiResponse>().api;

    // The re-read under the lease is the second one the delete makes. Answering
    // it with a different proxy id stands in for a rebuild that landed while
    // this delete was queued: the teardown must refuse rather than act on a
    // snapshot that no longer describes the gateway.
    const real = harness.store.apis.findById.bind(harness.store.apis);
    let reads = 0;
    harness.store.apis.findById = async (id): Promise<ApiRecord | null> => {
      const row = await real(id);
      reads += 1;
      if (!row || row.id !== api.id || reads !== 2) return row;
      return { ...row, ferrum_proxy_id: `${String(row.ferrum_proxy_id)}-moved` };
    };
    try {
      const removed = await harness.authed(provider, {
        method: 'DELETE',
        url: `/api/apis/${api.id}`,
      });
      assert.equal(removed.statusCode, 409, removed.body);
    } finally {
      harness.store.apis.findById = real;
    }

    assert.ok(
      harness.edge.proxyServing('/nexus/lifecycle-moved'),
      'the refused delete tore nothing down',
    );
    assert.equal(
      (await harness.auditRows('api.delete')).filter((row) => row.target_id === api.id).length,
      0,
      'no api.delete row for a teardown that never ran',
    );
    await harness.authed(provider, { method: 'DELETE', url: `/api/apis/${api.id}` });
  });

  /**
   * Answer the conversion's own existence check with "the row is gone".
   *
   * The lease is what stops an ordinary `DELETE` from interleaving with a
   * conversion, and it does. This is the backstop underneath it — an expired
   * lease under a stalled instance, or a row removed out of band — which no
   * lease can fence and which therefore has to be checked rather than assumed.
   * `arm` decides the moment the row vanishes; every read from then on answers
   * `null`, exactly as a committed delete would.
   *
   * @returns the undo, which must run before the assertions read the store
   */
  function vanishAfter(apiId: string, arm: (vanish: () => void) => () => void): () => void {
    const real = harness.store.apis.findById.bind(harness.store.apis);
    let vanished = false;
    const disarm = arm(() => {
      vanished = true;
    });
    harness.store.apis.findById = async (id): Promise<ApiRecord | null> =>
      vanished && id === apiId ? null : real(id);
    return () => {
      harness.store.apis.findById = real;
      disarm();
    };
  }

  it('rebuilds nothing when the row vanishes before the forward rebuild', async () => {
    const published = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: publishPayload('lifecycle-vanished'),
    });
    assert.equal(published.statusCode, 201, published.body);
    const api = published.json<PublishApiResponse>().api;
    const proxyId = String(api.ferrum_proxy_id);

    // The row goes as the conversion's `DELETE /proxies/{id}` returns, which is
    // the last instant it can: the very next thing the conversion does is ask
    // whether the portal still describes the API.
    const restore = vanishAfter(api.id, (vanish) => {
      const real = harness.edgeClient.proxies.delete.bind(harness.edgeClient.proxies);
      harness.edgeClient.proxies.delete = async (...args) => {
        const deleted = await real(...args);
        vanish();
        return deleted;
      };
      return () => {
        harness.edgeClient.proxies.delete = real;
      };
    });
    try {
      const failed = await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${api.id}`,
        payload: { spec_enforcement: 'routes' },
      });
      assert.equal(failed.statusCode, 404, failed.body);
    } finally {
      restore();
    }

    // Nothing serving is the one end state a deleted API can safely have. A
    // rebuild here would be the outcome issue #135 is about: a live proxy no
    // part of the product can find, holding the slug for good.
    assert.equal(
      harness.edge.proxyServing('/nexus/lifecycle-vanished'),
      undefined,
      'the conversion rebuilt nothing for an API the portal no longer describes',
    );
    assert.equal(harness.edge.proxies.get(`nexus/${proxyId}`), undefined, 'no staged proxy either');
    // And no repair row: the API having no gateway object is the *correct*
    // outcome here, not damage an operator has to go and fix.
    assert.deepEqual(await repairRows(harness, api.id), []);
    const row = await harness.store.apis.findById(api.id);
    assert.equal(row?.spec_enforcement, 'docs_only', 'the level the refused PATCH never moved');
  });

  it('rebuilds nothing when the row vanishes before the rollback', async () => {
    // The other direction: the conversion *succeeded*, a later step of the same
    // PATCH failed, and the undo step runs the same destructive restore. It has
    // to consult the same guard, or the unwind puts back exactly the orphan the
    // forward path refuses to create.
    const published = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: publishPayload('lifecycle-vanished-undo'),
    });
    assert.equal(published.statusCode, 201, published.body);
    const api = published.json<PublishApiResponse>().api;
    const proxyId = String(api.ferrum_proxy_id);

    // The catalog write that follows a successful conversion is what fails, and
    // it is also the moment the row goes.
    const restore = vanishAfter(api.id, (vanish) => {
      const real = harness.store.apis.update.bind(harness.store.apis);
      harness.store.apis.update = async () => {
        vanish();
        throw new Error('catalog write refused');
      };
      return () => {
        harness.store.apis.update = real;
      };
    });
    try {
      const failed = await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${api.id}`,
        payload: { spec_enforcement: 'routes' },
      });
      assert.equal(failed.statusCode, 500, failed.body);
    } finally {
      restore();
    }

    assert.equal(
      harness.edge.proxyServing('/nexus/lifecycle-vanished-undo'),
      undefined,
      'the rollback rebuilt nothing for an API the portal no longer describes',
    );
    assert.equal(harness.edge.proxies.get(`nexus/${proxyId}`), undefined, 'no staged proxy either');
    assert.deepEqual(await repairRows(harness, api.id), []);
  });
});

describe('a failed rollback of a successful enforcement conversion', () => {
  let harness: TestApp;
  let faults: FaultInjectingStore;
  let provider: TestSession;

  before(async () => {
    harness = await buildTestApp({
      wrapStore: (store) => {
        faults = faultInjectingStore(store);
        return faults.store;
      },
    });
    await harness.registerUser({ email: 'rollback-founder@example.test' });
    provider = await harness.registerUser({
      email: 'rollback-provider@example.test',
      role: 'provider',
    });
  });

  after(async () => {
    await harness.close();
  });

  // A queued failure is one-shot *and* matched: one a test armed but never met
  // would stay armed and fire inside the next test instead.
  afterEach(() => {
    harness.edge.clearInjections();
  });

  /**
   * Convert `from` → the other level successfully, fail the catalog write that
   * follows it, then fail the resulting rollback's rebuild — and assert the
   * repair record an operator has to be able to find.
   *
   * The conversion *succeeding* is the whole point: the forward path's own
   * guard never runs, so everything depends on the undo step the conversion
   * returned recording what it could not put back.
   *
   * @param breakRebuild queues the gateway failure that stops the rollback
   */
  async function assertRollbackRecordsRepair(
    slug: string,
    from: 'docs_only' | 'routes',
    breakRebuild: () => void,
  ): Promise<void> {
    const to = from === 'routes' ? 'docs_only' : 'routes';
    const published = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: publishPayload(slug, { spec_enforcement: from }),
    });
    assert.equal(published.statusCode, 201, published.body);
    const api = published.json<PublishApiResponse>().api;
    const proxyId = String(api.ferrum_proxy_id);
    const listenPath = `/nexus/${slug}`;
    assert.ok(harness.edge.proxyServing(listenPath), 'the API is live before the PATCH');

    // The store write that follows a successful conversion, and then the
    // rebuild the resulting rollback needs.
    faults.failNext('apis', 'update', new Error('catalog write refused'));
    breakRebuild();
    const failed = await harness.authed(provider, {
      method: 'PATCH',
      url: `/api/apis/${api.id}`,
      payload: { spec_enforcement: to, name: 'Renamed mid-conversion' },
    });
    assert.equal(failed.statusCode, 500, failed.body);
    assert.deepEqual(faults.pending(), [], 'the injected catalog write was reached');

    // The API is off the gateway: the state the record exists for.
    assert.equal(harness.edge.proxyServing(listenPath), undefined);

    // The portal still describes it exactly as it did before the PATCH…
    const reread = await harness.authed(provider, { method: 'GET', url: `/api/apis/${api.id}` });
    assert.equal(reread.statusCode, 200, reread.body);
    assert.equal(reread.json<GetApiResponse>().api.spec_enforcement, from);
    assert.equal(reread.json<GetApiResponse>().api.status, 'published');
    assert.equal(reread.json<GetApiResponse>().api.name, `Lifecycle ${slug}`);

    // …so the audit row is the only thing that can tell an operator.
    const rows = await repairRows(harness, api.id);
    assert.equal(rows.length, 1, 'exactly one repair row, from the rollback');
    const details = rows[0] ?? {};
    assert.equal(details.phase, 'rollback');
    assert.equal(details.proxy_id, proxyId);
    assert.equal(details.spec_enforcement, from);
    assert.equal(details.attempted_spec_enforcement, to);
    // The two levels read differently on this phase: the conversion to `to`
    // *succeeded*, and what failed is the way back — so the row says outright
    // what the restore was rebuilding rather than leaving it to be inferred.
    assert.equal(details.restore_target, from);
    assert.deepEqual(details.plugin_names, ['access_control', 'key_auth']);
    assert.equal(typeof details.restore_error, 'string');
    // `error` is the forward failure that made a restore necessary. The
    // conversion succeeded here, so there is none to report.
    assert.equal('error' in details, false);
    // The captured Edge resources never cross into the audit log.
    assert.equal('proxy' in details, false);
    assert.equal('plugin_configs' in details, false);
  }

  it('records the repair when a docs_only → routes rollback cannot rebuild', async () => {
    // `POST /proxies` is the rollback's own call: the forward conversion built
    // the replacement through `POST /api-specs`.
    await assertRollbackRecordsRepair('rollback-to-routes', 'docs_only', () =>
      harness.edge.queueFailure(503, { error: 'unavailable' }, '/proxies', 'POST'),
    );
  });

  it('records the repair when a routes → docs_only rollback cannot rebuild', async () => {
    // The opposite direction, and the mirror of the call above.
    await assertRollbackRecordsRepair('rollback-to-docs', 'routes', () =>
      harness.edge.queueFailure(503, { error: 'unavailable' }, '/api-specs', 'POST'),
    );
  });

  it('records the repair when the rollback rebuilds but cannot cut over', async () => {
    // The "delete tolerated, rebuild failed late" variant: the replacement and
    // its plugins are back, but it never moves off its staging path, so the
    // listen path serves nothing while the row still claims `routes`. The
    // cutover of a spec-owned rebuild is the only `PUT /api-specs/{id}` in the
    // whole PATCH, so no call counting is needed to land on it.
    await assertRollbackRecordsRepair('rollback-cutover', 'routes', () =>
      harness.edge.queueFailure(500, { error: 'rejected' }, '/api-specs/', 'PUT'),
    );
  });

  it('writes no repair row when the rollback succeeds', async () => {
    // The rollback puts the API back in its original mode, so there is nothing
    // for an operator to repair. This is what keeps the new record from firing
    // on every compensated PATCH.
    const published = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: publishPayload('rollback-clean'),
    });
    assert.equal(published.statusCode, 201, published.body);
    const api = published.json<PublishApiResponse>().api;
    const proxyId = String(api.ferrum_proxy_id);

    faults.failNext('apis', 'update', new Error('catalog write refused'));
    const failed = await harness.authed(provider, {
      method: 'PATCH',
      url: `/api/apis/${api.id}`,
      payload: { spec_enforcement: 'routes' },
    });
    assert.equal(failed.statusCode, 500, failed.body);

    assert.equal(String(harness.edge.proxyServing('/nexus/rollback-clean')?.id), proxyId);
    assert.equal(
      harness.edge.apiSpecForProxy(proxyId),
      undefined,
      'the gateway is back in docs_only, which is what the row says',
    );
    assert.deepEqual(await repairRows(harness, api.id), []);
  });

  it('writes no repair row when the PATCH succeeds', async () => {
    const published = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: publishPayload('rollback-happy'),
    });
    assert.equal(published.statusCode, 201, published.body);
    const api = published.json<PublishApiResponse>().api;

    const patched = await harness.authed(provider, {
      method: 'PATCH',
      url: `/api/apis/${api.id}`,
      payload: { spec_enforcement: 'routes' },
    });
    assert.equal(patched.statusCode, 200, patched.body);
    assert.deepEqual(await repairRows(harness, api.id), []);
  });

  it('still records the forward-path repair exactly once, tagged as the conversion', async () => {
    // Issue #61's record, unchanged and not duplicated by the new one: the
    // conversion itself failed and could not be put back.
    const published = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: publishPayload('rollback-forward'),
    });
    assert.equal(published.statusCode, 201, published.body);
    const api = published.json<PublishApiResponse>().api;

    harness.edge.queueFailure(503, { error: 'unavailable' }, '/api-specs', 'POST');
    harness.edge.queueFailure(503, { error: 'unavailable' }, '/proxies', 'POST');
    const failed = await harness.authed(provider, {
      method: 'PATCH',
      url: `/api/apis/${api.id}`,
      payload: { spec_enforcement: 'routes' },
    });
    assert.equal(failed.statusCode, 502, failed.body);

    const rows = await repairRows(harness, api.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.phase, 'conversion');
    assert.equal(typeof rows[0]?.error, 'string');
    // No `restore_target` on this phase: the conversion never got there, so
    // `attempted_spec_enforcement` is what it was reaching for and
    // `spec_enforcement` is what the restore tried to rebuild.
    assert.equal('restore_target' in (rows[0] ?? {}), false);
    assert.equal(rows[0]?.attempted_spec_enforcement, 'routes');
    assert.equal(rows[0]?.spec_enforcement, 'docs_only');
  });
});
