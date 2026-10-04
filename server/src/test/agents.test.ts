import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  aclGroupForApi,
  consumerUsernameForUser,
  type ApiAgents,
  type ApproveAccessRequestResponse,
  type CreateAccessRequestResponse,
  type PublishApiResponse,
} from '@ferrum-nexus/shared';
import type { EdgePluginConfigWrite } from '../ferrum-admin/types.js';
import { stampAgentDocument } from '../publishing/agents.js';
import { buildTestApp, type TestApp, type TestSession } from './helpers.js';

const AGENTS: ApiAgents = {
  operations: [{ path: '/items', method: 'GET', name: 'list_items', description: 'List items' }],
};
const DOCUMENT = {
  openapi: '3.1.0',
  info: { title: 'Agent API', version: '1' },
  servers: [{ url: 'https://api.example.com' }],
  'x-ferrum-mcp': { endpoint: { path: '/escape' }, include: { tags: ['all'] } },
  'x-ferrum-plugins': [{ plugin_name: 'ai_transcript_audit', config: { sink: 'provider' } }],
  paths: {
    '/items': {
      get: { operationId: 'items', responses: { '200': { description: 'OK' } } },
      post: { 'x-ferrum-mcp': true, responses: { '200': { description: 'OK' } } },
    },
    '/items/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      delete: { 'x-ferrum-mcp': { expose: true }, responses: { '200': { description: 'OK' } } },
    },
  },
};

describe('agent publishing and Nexus authorization', () => {
  let harness: TestApp;
  let provider: TestSession;
  let other: TestSession;
  let client: TestSession;
  let sequence = 0;

  before(async () => {
    harness = await buildTestApp();
    await harness.registerUser();
    provider = await harness.registerUser({ role: 'provider' });
    other = await harness.registerUser({ role: 'provider' });
    client = await harness.registerUser({ role: 'client' });
  });
  after(async () => harness.close());

  async function publish(overrides: Record<string, unknown> = {}): Promise<PublishApiResponse> {
    sequence += 1;
    const response = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: {
        name: 'Agent API',
        slug: `agent-${sequence}`,
        spec: JSON.stringify(DOCUMENT),
        auth_plugin: 'key_auth',
        requestable: true,
        visibility: 'public',
        spec_enforcement: 'routes',
        agents: AGENTS,
        ...overrides,
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<PublishApiResponse>();
  }

  it('defaults off and stamps only selected operations with the approval group', async () => {
    const off = await publish({ agents: null });
    assert.equal(off.api.agents, null);
    const published = await publish();
    const proxyId = published.api.ferrum_proxy_id;
    assert.ok(proxyId);
    const spec = [...harness.edge.apiSpecs.values()].find((item) => item.proxy_id === proxyId);
    assert.ok(spec);
    const submitted = spec.document;
    assert.equal(submitted['x-ferrum-validate'], undefined);
    assert.deepEqual(submitted['x-ferrum-mcp'], {
      enabled: true,
      endpoint: { path: `${published.api.listen_path}/mcp` },
      namespace: published.api.slug,
    });
    const paths = submitted.paths as typeof DOCUMENT.paths;
    assert.deepEqual(paths['/items'].post['x-ferrum-mcp'], { expose: false });
    assert.deepEqual(paths['/items/{id}'].delete['x-ferrum-mcp'], { expose: false });
    const configs = harness.edge.effectivePluginsForProxy(proxyId);
    const gateway = configs.find((item) => item.plugin_name === 'mcp_gateway');
    const policy = (gateway?.config as { policy: Record<string, unknown> }).policy;
    assert.equal(policy.default_action, 'deny');
    assert.deepEqual(policy.tools, {
      [`${published.api.slug}.list_items`]: {
        action: 'allow',
        allowed_groups: [aclGroupForApi(published.api.id)],
      },
    });
    const routes = configs.find((item) => item.plugin_name === 'openapi_validator');
    const bypass = (routes?.config as { bypass: { paths: string[] } }).bypass;
    assert.deepEqual(bypass, {
      paths: [`^/nexus/${published.api.slug.replaceAll('-', '\\-')}/mcp$`],
    });
    const [pattern] = bypass.paths;
    assert.ok(pattern);
    const matcher = new RegExp(pattern);
    const endpoint = `${published.api.listen_path}/mcp`;
    assert.equal(matcher.test(endpoint), true);
    for (const alternative of [
      `${endpoint}/child`,
      `${endpoint}-sibling`,
      `/prefix${endpoint}`,
      endpoint.replace(published.api.slug, `${published.api.slug}-sibling`),
      endpoint.replace('-', '.'),
    ]) {
      assert.equal(matcher.test(alternative), false, alternative);
    }
    assert.equal(
      configs.some((item) => item.plugin_name === 'ai_transcript_audit'),
      false,
    );
    const governor = configs.find((item) => item.plugin_name === 'ai_tool_governor');
    assert.deepEqual((governor?.config as Record<string, unknown>).inspect, {
      mcp_tool_calls: true,
      response_tool_calls: false,
    });
    assert.equal((governor?.config as Record<string, unknown>).default_action, 'deny');
    const shield = configs.find((item) => item.plugin_name === 'ai_prompt_shield');
    assert.equal((shield?.config as Record<string, unknown>).scan_fields, 'mcp_arguments');
    const budget = configs.find(
      (item) =>
        item.plugin_name === 'rate_limiting' && String(item.id).endsWith('nexus-tool-budget'),
    );
    assert.deepEqual((budget?.config as Record<string, unknown>).mcp_tool_calls, {
      endpoint_path: `${published.api.listen_path}/mcp`,
    });
    assert.ok(
      (await harness.auditRows('api.publish')).some((row) => row.target_id === published.api.id),
    );
  });

  it('keeps namespace metacharacters literal in the MCP validator bypass', () => {
    const document: Record<string, unknown> = structuredClone(DOCUMENT);
    const listenPath = '/nexus.agents-1/agent-2';
    stampAgentDocument(
      document,
      { id: 'literal-path', listen_path: listenPath },
      {
        apiId: 'literal-api',
        slug: 'agent-2',
        agents: AGENTS,
        sync: { syncMode: 'local', redisUrl: undefined, redisTls: false },
      },
    );
    const plugins = document['x-ferrum-plugins'] as EdgePluginConfigWrite[];
    const routes = plugins.find((plugin) => plugin.plugin_name === 'openapi_validator');
    const bypass = (routes?.config as { bypass: { paths: string[] } }).bypass;
    assert.deepEqual(bypass.paths, ['^/nexus\\.agents\\-1/agent\\-2/mcp$']);
    const [pattern] = bypass.paths;
    assert.ok(pattern);
    const matcher = new RegExp(pattern);
    assert.equal(matcher.test(`${listenPath}/mcp`), true);
    for (const alternative of [
      '/nexusXagents-1/agent-2/mcp',
      '/nexus/agents-1/agent-2/mcp',
      '/nexus.agents-1/agentX2/mcp',
      `${listenPath}/mcp/child`,
      `${listenPath}/mcpx`,
      `/prefix${listenPath}/mcp`,
    ]) {
      assert.equal(matcher.test(alternative), false, alternative);
    }
  });

  it('refuses unsafe selections and dependent settings before gateway mutations', async () => {
    const invalid: Record<string, unknown>[] = [
      { spec_enforcement: 'docs_only' },
      { requestable: false },
      { allowed_methods: ['GET'] },
      { agents: { operations: [] } },
      { agents: { ...AGENTS, endpoint: '/escape' } },
      { agents: { operations: [{ ...AGENTS.operations[0], allowed_groups: ['everyone'] }] } },
      { agents: { operations: [{ ...AGENTS.operations[0], method: 'HEAD' }] } },
      { agents: { operations: [{ ...AGENTS.operations[0], name: 'bad name' }] } },
      { agents: { operations: [AGENTS.operations[0], AGENTS.operations[0]] } },
      { agents: { operations: [{ ...AGENTS.operations[0], path: '/missing' }] } },
      ...['/mcp', '/mcp/child', '/{route}', '/{route}/child', '/../escape', '/%2e%2e/escape'].map(
        (path) => ({
          spec: JSON.stringify({ ...DOCUMENT, paths: { [path]: DOCUMENT.paths['/items'] } }),
          agents: { operations: [{ ...AGENTS.operations[0], path }] },
        }),
      ),
    ];
    for (const fields of invalid) {
      const before = harness.edge.requests.length;
      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: {
          name: 'Invalid agent API',
          slug: `invalid-agent-${sequence++}`,
          spec: JSON.stringify(DOCUMENT),
          auth_plugin: 'key_auth',
          requestable: true,
          visibility: 'public',
          spec_enforcement: 'routes',
          agents: AGENTS,
          ...fields,
        },
      });
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(
        harness.edge.requests.slice(before).some((request) => request.method !== 'GET'),
        false,
      );
    }
  });

  it('uses the existing approval and revocation group for public and private APIs', async () => {
    for (const visibility of ['public', 'private']) {
      const { api } = await publish({ visibility });
      if (visibility === 'private') {
        const viewer = await harness.authed(provider, {
          method: 'POST',
          url: `/api/apis/${api.id}/viewers`,
          payload: { user_id: client.user.id },
        });
        assert.equal(viewer.statusCode, 201, viewer.body);
      }
      const request = await harness.authed(client, {
        method: 'POST',
        url: '/api/access-requests',
        payload: { api_id: api.id, justification: 'Use agent tools' },
      });
      assert.equal(request.statusCode, 201, request.body);
      const requestId = request.json<CreateAccessRequestResponse>().access_request.id;
      const approved = await harness.authed(provider, {
        method: 'POST',
        url: `/api/access-requests/${requestId}/approve`,
        payload: {},
      });
      assert.equal(approved.statusCode, 200, approved.body);
      const grant = approved.json<ApproveAccessRequestResponse>().grant;
      const consumer = harness.edge.consumerByUsername(consumerUsernameForUser(client.user.id));
      assert.ok((consumer?.acl_groups as string[]).includes(aclGroupForApi(api.id)));
      const revoked = await harness.authed(provider, {
        method: 'POST',
        url: `/api/grants/${grant.id}/revoke`,
        payload: {},
      });
      assert.equal(revoked.statusCode, 200, revoked.body);
      const after = harness.edge.consumerByUsername(consumerUsernameForUser(client.user.id));
      assert.equal((after?.acl_groups as string[]).includes(aclGroupForApi(api.id)), false);
    }
  });

  it('requires owner authorization and CSRF, and audits updates with their row', async () => {
    const { api } = await publish();
    const outsider = await harness.authed(other, {
      method: 'PATCH',
      url: `/api/apis/${api.id}`,
      payload: { agents: null },
    });
    assert.equal(outsider.statusCode, 403);
    const noCsrf = await harness.app.inject({
      method: 'PATCH',
      url: `/api/apis/${api.id}`,
      headers: { cookie: provider.cookieHeader },
      payload: { agents: null },
    });
    assert.equal(noCsrf.statusCode, 403);
    const disabled = await harness.authed(provider, {
      method: 'PATCH',
      url: `/api/apis/${api.id}`,
      payload: { agents: null },
    });
    assert.equal(disabled.statusCode, 200, disabled.body);
    assert.equal((await harness.store.apis.findById(api.id))?.agents, null);
    assert.equal(
      harness.edge
        .effectivePluginsForProxy(api.ferrum_proxy_id ?? '')
        .some((item) => item.plugin_name === 'mcp_gateway'),
      false,
    );
    assert.ok(
      (await harness.auditRows('api.agents_update_start')).some((row) => row.target_id === api.id),
    );
    assert.ok((await harness.auditRows('api.update')).some((row) => row.target_id === api.id));
  });

  it('keeps selected tools explicit across revisions and compensates failed policy persistence', async () => {
    const { api } = await publish();
    const missing = await harness.authed(provider, {
      method: 'PUT',
      url: `/api/apis/${api.id}/spec`,
      payload: {
        spec: JSON.stringify({ ...DOCUMENT, paths: { '/new': DOCUMENT.paths['/items'] } }),
      },
    });
    assert.equal(missing.statusCode, 400, missing.body);
    const gateway = harness.edge
      .effectivePluginsForProxy(api.ferrum_proxy_id ?? '')
      .find((item) => item.plugin_name === 'mcp_gateway');
    assert.ok(gateway);
    gateway.priority_override = 2_991;
    const real = harness.store.apis.update.bind(harness.store.apis);
    harness.store.apis.update = async () => {
      harness.store.apis.update = real;
      throw new Error('policy persistence unavailable');
    };
    const failed = await harness.authed(provider, {
      method: 'PATCH',
      url: `/api/apis/${api.id}`,
      payload: { agents: null },
    });
    assert.equal(failed.statusCode, 500, failed.body);
    assert.deepEqual((await harness.store.apis.findById(api.id))?.agents, AGENTS);
    const restored = harness.edge
      .effectivePluginsForProxy(api.ferrum_proxy_id ?? '')
      .find((item) => item.plugin_name === 'mcp_gateway');
    assert.ok(restored);
    assert.equal(restored.priority_override, 2_991);
  });

  it('enables existing routes APIs with explicit mutations and protects fixed policy from palette writes', async () => {
    const { api } = await publish({ agents: null });
    const priorValidator = harness.edge
      .effectivePluginsForProxy(api.ferrum_proxy_id ?? '')
      .find((item) => item.plugin_name === 'openapi_validator');
    assert.ok(priorValidator);
    priorValidator.priority_override = 2_959;
    const selection: ApiAgents = {
      operations: [
        ...AGENTS.operations,
        { path: '/items/{id}', method: 'DELETE', name: 'remove', description: 'Delete one item' },
      ],
    };
    const enabled = await harness.authed(provider, {
      method: 'PATCH',
      url: `/api/apis/${api.id}`,
      payload: { agents: selection },
    });
    assert.equal(enabled.statusCode, 200, enabled.body);
    assert.equal(
      harness.edge
        .effectivePluginsForProxy(api.ferrum_proxy_id ?? '')
        .find((item) => item.plugin_name === 'openapi_validator')?.priority_override,
      2_959,
    );
    const gateway = harness.edge
      .effectivePluginsForProxy(api.ferrum_proxy_id ?? '')
      .find((item) => item.plugin_name === 'mcp_gateway');
    const policy = (gateway?.config as { policy: { tools: Record<string, unknown> } }).policy;
    assert.deepEqual(policy.tools[`${api.slug}.remove`], {
      action: 'allow',
      allowed_groups: [aclGroupForApi(api.id)],
    });
    for (const name of [
      'mcp_gateway',
      'ai_tool_governor',
      'ai_prompt_shield',
      'ai_transcript_audit',
    ]) {
      const response = await harness.authed(provider, {
        method: 'PUT',
        url: `/api/apis/${api.id}/plugins/${name}`,
        payload: { enabled: true, config: { default_action: 'allow', sink: 'provider' } },
      });
      assert.equal(response.statusCode, name === 'ai_transcript_audit' ? 404 : 400, response.body);
    }
  });

  it('refuses a deterministic plugin id that is no longer owned by its spec', async () => {
    const { api } = await publish();
    const gateway = harness.edge
      .effectivePluginsForProxy(api.ferrum_proxy_id ?? '')
      .find((item) => item.plugin_name === 'mcp_gateway');
    assert.ok(gateway);
    delete gateway.api_spec_id;
    const changed = await harness.authed(provider, {
      method: 'PATCH',
      url: `/api/apis/${api.id}`,
      payload: {
        agents: { operations: [{ ...AGENTS.operations[0], description: 'New description' }] },
      },
    });
    assert.equal(changed.statusCode, 409, changed.body);
    assert.deepEqual((await harness.store.apis.findById(api.id))?.agents, AGENTS);
  });

  it('undoes a policy write even when its acknowledgement is lost', async () => {
    const { api } = await publish();
    harness.edge.queueLostAck(503, undefined, '/api-specs/', 'PUT');
    const failed = await harness.authed(provider, {
      method: 'PATCH',
      url: `/api/apis/${api.id}`,
      payload: { agents: null },
    });
    assert.ok(failed.statusCode >= 500, failed.body);
    assert.deepEqual((await harness.store.apis.findById(api.id))?.agents, AGENTS);
    const gateway = harness.edge
      .effectivePluginsForProxy(api.ferrum_proxy_id ?? '')
      .find((item) => item.plugin_name === 'mcp_gateway');
    assert.ok(gateway, 'the policy must be restored after the lost write acknowledgement');
  });

  it('restores the method policy with a removed tool when a combined save fails', async () => {
    const agents: ApiAgents = {
      operations: [
        ...AGENTS.operations,
        { path: '/items/{id}', method: 'DELETE', name: 'remove', description: 'Delete one item' },
      ],
    };
    const { api } = await publish({ agents });
    const real = harness.store.apis.update.bind(harness.store.apis);
    harness.store.apis.update = async () => {
      harness.store.apis.update = real;
      throw new Error('combined save unavailable');
    };
    const failed = await harness.authed(provider, {
      method: 'PATCH',
      url: `/api/apis/${api.id}`,
      payload: { agents: AGENTS, allowed_methods: ['GET', 'POST'] },
    });
    assert.equal(failed.statusCode, 500, failed.body);
    assert.deepEqual((await harness.store.apis.findById(api.id))?.agents, agents);
    const proxy = harness.edge.proxyServing(api.listen_path);
    assert.ok(proxy);
    assert.equal(proxy?.allowed_methods ?? null, null);
    const gateway = harness.edge
      .effectivePluginsForProxy(api.ferrum_proxy_id ?? '')
      .find((item) => item.plugin_name === 'mcp_gateway');
    const policy = (gateway?.config as { policy: { tools: Record<string, unknown> } }).policy;
    assert.deepEqual(policy.tools[`${api.slug}.remove`], {
      action: 'allow',
      allowed_groups: [aclGroupForApi(api.id)],
    });
  });

  it('enables agents while converting docs-only enforcement and adding MCP transport POST', async () => {
    const { api } = await publish({
      agents: null,
      spec_enforcement: 'docs_only',
      allowed_methods: ['GET'],
    });
    const converted = await harness.authed(provider, {
      method: 'PATCH',
      url: `/api/apis/${api.id}`,
      payload: {
        agents: AGENTS,
        spec_enforcement: 'routes',
        allowed_methods: ['GET', 'POST'],
      },
    });
    assert.equal(converted.statusCode, 200, converted.body);
    const proxy = harness.edge.proxyServing(api.listen_path);
    assert.ok(proxy);
    assert.deepEqual(proxy.allowed_methods, ['GET', 'POST']);
    assert.ok(
      harness.edge
        .effectivePluginsForProxy(api.ferrum_proxy_id ?? '')
        .some((item) => item.plugin_name === 'mcp_gateway'),
    );
  });
});
