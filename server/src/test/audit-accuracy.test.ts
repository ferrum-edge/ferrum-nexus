import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ListAuditLogsResponse, PublishApiResponse } from '@ferrum-nexus/shared';

import { buildTestApp, SAMPLE_SPEC_YAML } from './helpers.js';

test('audit pages batch actor summaries and normalize inclusive/exclusive bounds', async () => {
  const h = await buildTestApp();
  try {
    const founder = await h.registerUser({ email: 'founder@example.test' });
    const unavailable = await h.registerUser();
    const unknown = unavailable.user.id;
    for (const [index, actorId] of [founder.user.id, founder.user.id, unknown, null].entries()) {
      await h.store.auditLogs.create({
        actor_user_id: actorId,
        actor_role: actorId ? 'super_admin' : null,
        action: 'test.window',
        target_type: 'user',
        target_id: null,
        details: {},
        ip: null,
        created_at: `2026-09-08T01:46:15.${index}00Z`,
      });
    }
    const batches: string[][] = [];
    const findMany = h.store.users.findManyByIds.bind(h.store.users);
    h.store.users.findManyByIds = async (ids) => {
      batches.push(ids);
      // Model a historical actor that the user lookup can no longer resolve.
      return (await findMany(ids)).filter((user) => user.id !== unknown);
    };
    const response = await h.authed(founder, {
      method: 'GET',
      url: '/api/admin/audit-logs?action=test.window&from=2026-09-08T01:46:15Z',
    });
    assert.equal(response.statusCode, 200, response.body);
    const page = response.json<ListAuditLogsResponse>();
    assert.equal(page.total, 4);
    assert.deepEqual(batches, [[unknown, founder.user.id]]);
    for (const row of page.items) {
      assert.equal(Object.hasOwn(row, 'actor'), true);
      assert.deepEqual(
        row.actor,
        row.actor_user_id === founder.user.id
          ? {
              id: founder.user.id,
              email: founder.user.email,
              display_name: founder.user.display_name,
              role: founder.user.role,
            }
          : null,
      );
    }
    for (const bound of ['2026-09-08T01:46:15Z', '2026-09-08T01:46:15.000Z']) {
      for (const [key, expected] of [
        ['from', 4],
        ['to', 0],
      ] as const) {
        const filter = { action: 'test.window', [key]: bound };
        assert.equal((await h.services.audit.list(filter)).total, expected);
        assert.equal(await h.services.audit.count(filter), expected);
        const result = await h.authed(founder, {
          method: 'GET',
          url: `/api/admin/audit-logs?action=test.window&${key}=${bound}`,
        });
        assert.equal(result.statusCode, 200, result.body);
        assert.equal(result.json<ListAuditLogsResponse>().total, expected);
      }
    }
  } finally {
    await h.close();
  }
});

for (const initialStatus of ['active', 'disabled'] as const) {
  for (const roleChanged of [false, true]) {
    for (const statusChanged of [false, true]) {
      const name = `audit: ${initialStatus}, role=${roleChanged}, status=${statusChanged}`;
      test(name, async () => {
        const h = await buildTestApp();
        try {
          const founder = await h.registerUser();
          const client = await h.registerUser({ role: 'client' });
          await h.store.users.update(client.user.id, { status: initialStatus });
          const status = statusChanged
            ? initialStatus === 'active'
              ? 'disabled'
              : 'active'
            : initialStatus;
          const role = roleChanged ? 'provider' : 'client';
          const response = await h.authed(founder, {
            method: 'PATCH',
            url: `/api/users/${client.user.id}`,
            payload: { role, status },
          });
          assert.equal(response.statusCode, 200, response.body);
          const rows = (await h.auditRows()).filter(
            (row) => row.target_id === client.user.id && row.action.startsWith('user.'),
          );
          const expected = [];
          if (roleChanged) expected.push('user.role_change');
          if (statusChanged) expected.push(status === 'active' ? 'user.enable' : 'user.disable');
          assert.deepEqual(rows.map((row) => row.action).sort(), expected.sort());
          for (const row of rows) {
            if (roleChanged) {
              assert.equal(row.details.from_role, 'client');
              assert.equal(row.details.to_role, role);
            }
            if (statusChanged) {
              assert.equal(row.details.from_status, initialStatus);
              assert.equal(row.details.to_status, status);
            }
          }
        } finally {
          await h.close();
        }
      });
    }
  }
}

test('god-mode disable also records the ordinary disable event', async () => {
  const h = await buildTestApp();
  try {
    const founder = await h.registerUser();
    const client = await h.registerUser();
    const response = await h.authed(founder, {
      method: 'POST',
      url: '/api/admin/god/disable-user',
      payload: { user_id: client.user.id, reason: 'Emergency suspension' },
    });
    assert.equal(response.statusCode, 200, response.body);
    for (const action of ['god.disable_user', 'user.disable']) {
      const rows = (await h.auditRows(action)).filter((row) => row.target_id === client.user.id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.actor_user_id, founder.user.id);
    }
  } finally {
    await h.close();
  }
});

test('profile, organization and API audit fields exclude unchanged submitted values', async () => {
  const h = await buildTestApp();
  try {
    const founder = await h.registerUser();
    const organization = await h.store.organizations.create({
      name: 'Team',
      description: 'Original',
    });
    const published = await h.authed(founder, {
      method: 'POST',
      url: '/api/apis',
      payload: {
        name: 'Example',
        slug: 'audit-fields',
        spec: SAMPLE_SPEC_YAML,
        auth_plugin: 'key_auth',
        requestable: true,
        visibility: 'public',
      },
    });
    assert.equal(published.statusCode, 201, published.body);
    const api = published.json<PublishApiResponse>().api;
    const cases = [
      {
        url: '/api/users/me',
        action: 'user.update',
        same: {
          display_name: founder.user.display_name,
          company: founder.user.company,
          phone: founder.user.phone,
        },
        change: { company: 'Changed' },
        field: 'company',
      },
      {
        url: `/api/organizations/${organization.id}`,
        action: 'org.update',
        same: { name: organization.name },
        change: { description: 'Changed' },
        field: 'description',
      },
      {
        url: `/api/apis/${api.id}`,
        action: 'api.update',
        same: {
          name: api.name,
          description: api.description,
          version: api.version,
          cors: api.cors,
          allowed_methods: api.allowed_methods,
          timeouts: api.timeouts,
        },
        change: { name: 'Changed' },
        field: 'name',
      },
    ];
    for (const scenario of cases) {
      const before = (await h.auditRows(scenario.action)).length;
      const noop = await h.authed(founder, {
        method: 'PATCH',
        url: scenario.url,
        payload: scenario.same,
      });
      assert.equal(noop.statusCode, 200, noop.body);
      assert.equal((await h.auditRows(scenario.action)).length, before);
      const changed = await h.authed(founder, {
        method: 'PATCH',
        url: scenario.url,
        payload: { ...scenario.same, ...scenario.change },
      });
      assert.equal(changed.statusCode, 200, changed.body);
      const rows = await h.auditRows(scenario.action);
      assert.equal(rows.length, before + 1);
      assert.deepEqual(rows[0]?.details.changed_fields, [scenario.field]);
    }
  } finally {
    await h.close();
  }
});

test('a failed in-app message notification still enqueues mail', async () => {
  const h = await buildTestApp();
  try {
    await h.registerUser();
    const provider = await h.registerUser({ role: 'provider' });
    const client = await h.registerUser({ role: 'client' });
    h.services.notifications.notify = async () => {
      throw new Error('Notification unavailable');
    };
    const before = (await h.outbox()).length;
    const response = await h.authed(client, {
      method: 'POST',
      url: '/api/threads',
      payload: {
        subject: 'Notification regression',
        recipient_user_id: provider.user.id,
        body: 'Please help with access.',
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    const queued = await h.outbox();
    assert.equal(queued.length, before + 1);
    assert.ok(queued.some((row) => row.subject.includes('Notification regression')));
  } finally {
    await h.close();
  }
});
