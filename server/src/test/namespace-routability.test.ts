/**
 * ferrum-nexus#230 — a proxy published into a namespace the gateway's data
 * plane does not route is accepted by the Admin API and answers `404` on the
 * listener, while the portal reports itself healthy.
 *
 * The portal cannot make the proxy work; what it can do is stop claiming that
 * it does. These tests pin both halves of that: `GET /api/health` goes
 * `degraded` with a named reason, and a publish is refused before the first
 * gateway write. Both of Edge's signals are exercised — the `namespace` block
 * on the authenticated health payload, and `X-Ferrum-Namespace-Unserved` on an
 * accepted mutation — and so is the case that must change nothing at all: a
 * gateway that reports neither.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ApiErrorBody, AppHealth, PublishApiResponse } from '@ferrum-nexus/shared';

import { checkNamespaceRoutability } from '../ferrum-admin/reconcile.js';
import { buildTestApp, SAMPLE_SPEC_YAML, type TestApp, type TestSession } from './helpers.js';

/** The namespace `buildTestApp` configures Nexus with. */
const PORTAL_NAMESPACE = 'nexus';

/** Body of `POST /api/apis`, with a slug the caller chooses. */
function publishPayload(slug: string): Record<string, unknown> {
  return {
    name: `API ${slug}`,
    slug,
    version: '1.0.0',
    spec: SAMPLE_SPEC_YAML,
    auth_plugin: 'key_auth',
    requestable: true,
    visibility: 'public',
  };
}

function errorCode(body: string): string {
  return (JSON.parse(body) as ApiErrorBody).error.code;
}

/** A portal with a founding admin and a provider ready to publish. */
async function portal(): Promise<{
  harness: TestApp;
  admin: TestSession;
  provider: TestSession;
}> {
  const harness = await buildTestApp();
  // The first registration is seated as the portal's super_admin.
  const admin = await harness.registerUser();
  const provider = await harness.registerUser({ role: 'provider' });
  return { harness, admin, provider };
}

describe('namespace routability', () => {
  it('degrades health and refuses a publish the data plane would not route', async (t) => {
    const { harness, admin, provider } = await portal();
    t.after(() => harness.close());
    harness.edge.setServedNamespace('ferrum');

    const anonymous = await harness.app.inject({ method: 'GET', url: '/api/health' });
    // Degraded is not down: the portal stays in a load balancer's rotation.
    assert.equal(anonymous.statusCode, 200, anonymous.body);
    const body = anonymous.json<AppHealth>();
    assert.equal(body.status, 'degraded');
    assert.equal(body.edge.status, 'degraded');
    assert.equal(body.edge.reason, 'namespace_unserved');
    assert.equal(body.edge.ready, true, 'the gateway itself is healthy');
    assert.equal(body.edge.namespace, PORTAL_NAMESPACE);
    assert.equal(body.edge.namespace_routing.unserved, true);
    // The gateway's own topology is admin-only, exactly as `mode` is.
    assert.equal(body.edge.namespace_routing.active, null);
    assert.equal(body.edge.namespace_routing.serving_scope, null);
    assert.equal(body.edge.namespace_routing.data_plane_single_namespace, null);

    const detailed = await harness.authed(admin, { method: 'GET', url: '/api/health' });
    const detail = detailed.json<AppHealth>().edge.namespace_routing;
    assert.equal(detail.configured, PORTAL_NAMESPACE);
    assert.equal(detail.active, 'ferrum');
    assert.equal(detail.serving_scope, 'single-namespace-data-plane');
    assert.equal(detail.data_plane_single_namespace, true);
    assert.ok(detail.checked_at !== null);

    const before = harness.edge.requests.length;
    const refused = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: publishPayload('unrouted'),
    });
    assert.equal(refused.statusCode, 409, refused.body);
    assert.equal(errorCode(refused.body), 'EDGE_NAMESPACE_UNSERVED');
    // Both namespaces and the way out, or an operator cannot act on it.
    assert.match(refused.body, /nexus/);
    assert.match(refused.body, /ferrum/);
    assert.match(refused.body, /FERRUM_NAMESPACE/);
    assert.equal(harness.edge.requests.length, before, 'refused before any gateway write');
    assert.equal(harness.edge.proxies.size, 0);
  });

  it('refuses a spec revision on an already published API', async (t) => {
    const { harness, provider } = await portal();
    t.after(() => harness.close());

    const published = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: publishPayload('revisable'),
    });
    assert.equal(published.statusCode, 201, published.body);
    const apiId = published.json<PublishApiResponse>().api.id;

    harness.edge.setServedNamespace('ferrum');
    await harness.app.inject({ method: 'GET', url: '/api/health' });
    const refused = await harness.authed(provider, {
      method: 'PUT',
      url: `/api/apis/${apiId}/spec`,
      payload: { spec: SAMPLE_SPEC_YAML, version: '1.1.0' },
    });
    assert.equal(refused.statusCode, 409, refused.body);
    assert.equal(errorCode(refused.body), 'EDGE_NAMESPACE_UNSERVED');

    // Teardown is deliberately not gated: fixing a mismatched deployment has
    // to include removing what the portal published into the wrong namespace.
    const removed = await harness.authed(provider, {
      method: 'DELETE',
      url: `/api/apis/${apiId}`,
    });
    assert.equal(removed.statusCode, 200, removed.body);
  });

  it('changes nothing when the gateway serves the portal namespace', async (t) => {
    const { harness, admin, provider } = await portal();
    t.after(() => harness.close());
    harness.edge.setServedNamespace(PORTAL_NAMESPACE);

    const health = await harness.authed(admin, { method: 'GET', url: '/api/health' });
    const body = health.json<AppHealth>();
    assert.equal(body.status, 'ok');
    assert.equal(body.edge.status, 'ok');
    assert.equal(body.edge.reason, null);
    assert.equal(body.edge.namespace_routing.unserved, false);
    assert.equal(body.edge.namespace_routing.active, PORTAL_NAMESPACE);

    const published = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: publishPayload('routed'),
    });
    assert.equal(published.statusCode, 201, published.body);
  });

  it('changes nothing against a gateway that reports no namespace block', async (t) => {
    const { harness, admin, provider } = await portal();
    t.after(() => harness.close());
    // The mock's default health payload — every Edge released before the block.

    const health = await harness.authed(admin, { method: 'GET', url: '/api/health' });
    const body = health.json<AppHealth>();
    assert.equal(body.status, 'ok');
    assert.equal(body.edge.status, 'ok');
    assert.equal(body.edge.reason, null);
    // Unknown topology is never a verdict.
    assert.equal(body.edge.namespace_routing.unserved, false);
    assert.equal(body.edge.namespace_routing.active, null);
    assert.equal(body.edge.namespace_routing.data_plane_single_namespace, null);
    assert.equal(body.edge.namespace_routing.checked_at, null);

    const published = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: publishPayload('legacy-gateway'),
    });
    assert.equal(published.statusCode, 201, published.body);
  });

  it('degrades on the response header alone, without a health block to read', async (t) => {
    const { harness, admin, provider } = await portal();
    t.after(() => harness.close());

    // The first publish is accepted: nothing has told the portal anything yet.
    const first = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: publishPayload('before-the-marker'),
    });
    assert.equal(first.statusCode, 201, first.body);

    harness.edge.setServedNamespace('ferrum', { announce: false });
    const marked = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: publishPayload('carries-the-marker'),
    });
    assert.equal(marked.statusCode, 201, marked.body);

    const health = await harness.authed(admin, { method: 'GET', url: '/api/health' });
    const routing = health.json<AppHealth>().edge.namespace_routing;
    assert.equal(health.json<AppHealth>().edge.status, 'degraded');
    assert.equal(health.json<AppHealth>().edge.reason, 'namespace_unserved');
    assert.equal(routing.unserved, true);
    assert.equal(routing.unserved_mutation_observed, true);
    // The header says which namespace is wrong, never which one is right.
    assert.equal(routing.active, null);

    const refused = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: publishPayload('after-the-marker'),
    });
    assert.equal(refused.statusCode, 409, refused.body);
    assert.equal(errorCode(refused.body), 'EDGE_NAMESPACE_UNSERVED');
    assert.match(refused.body, /namespace\.active/);
  });

  it('never marks a read, and lets the gateway take the verdict back', async (t) => {
    const { harness, admin, provider } = await portal();
    t.after(() => harness.close());

    harness.edge.setServedNamespace('ferrum', { announce: false });
    // Reads and catalog browsing must not trip the marker.
    assert.equal(
      (await harness.authed(provider, { method: 'GET', url: '/api/apis' })).statusCode,
      200,
    );
    let health = await harness.authed(admin, { method: 'GET', url: '/api/health' });
    assert.equal(health.json<AppHealth>().edge.status, 'ok');

    // A write does, and a gateway that later says it serves this namespace
    // supersedes it — otherwise a fixed deployment stays degraded until it
    // restarts.
    const published = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: publishPayload('marker-then-recovery'),
    });
    assert.equal(published.statusCode, 201, published.body);
    health = await harness.authed(admin, { method: 'GET', url: '/api/health' });
    assert.equal(health.json<AppHealth>().edge.status, 'degraded');

    harness.edge.setServedNamespace(PORTAL_NAMESPACE);
    health = await harness.authed(admin, { method: 'GET', url: '/api/health' });
    assert.equal(health.json<AppHealth>().edge.status, 'ok');
    assert.equal(health.json<AppHealth>().edge.namespace_routing.unserved_mutation_observed, false);
    assert.equal(
      (
        await harness.authed(provider, {
          method: 'POST',
          url: '/api/apis',
          payload: publishPayload('after-recovery'),
        })
      ).statusCode,
      201,
    );
  });

  it('seeds the verdict at startup, before anything probes /api/health', async (t) => {
    const { harness, provider } = await portal();
    t.after(() => harness.close());
    harness.edge.setServedNamespace('ferrum');

    assert.equal(await checkNamespaceRoutability(harness.edgeClient, harness.app.log), false);
    const refused = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: publishPayload('startup-seeded'),
    });
    assert.equal(refused.statusCode, 409, refused.body);

    harness.edge.setServedNamespace(PORTAL_NAMESPACE);
    assert.equal(await checkNamespaceRoutability(harness.edgeClient, harness.app.log), true);
  });
});
