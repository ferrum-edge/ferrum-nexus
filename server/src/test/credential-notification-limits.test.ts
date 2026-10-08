import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { IssueCredentialResponse, MarkNotificationsReadResponse } from '@ferrum-nexus/shared';

import { buildTestApp, type TestApp, type TestSession } from './helpers.js';

describe('credential and notification write limits', () => {
  let harness: TestApp;
  let owner: TestSession;
  let other: TestSession;

  before(async () => {
    harness = await buildTestApp({
      env: { NEXUS_ENV: 'development', NEXUS_RATE_LIMIT_ENABLED: 'true' },
    });
    owner = await harness.registerUser({ email: 'write-limit-owner@example.test' });
    other = await harness.registerUser({ email: 'write-limit-other@example.test' });
  });

  after(async () => {
    await harness.close();
  });

  it('caps credential issuance per account', async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const issued = await harness.authed(owner, {
        method: 'POST',
        url: '/api/credentials',
        payload: { credential_type: 'keyauth' },
      });
      assert.equal(issued.statusCode, 201, issued.body);
      const credentialId = issued.json<IssueCredentialResponse>().credential.id;
      const revoked = await harness.authed(owner, {
        method: 'DELETE',
        url: `/api/credentials/${credentialId}`,
      });
      assert.equal(revoked.statusCode, 200, revoked.body);
    }

    const refused = await harness.authed(owner, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'keyauth' },
    });
    assert.equal(refused.statusCode, 429, refused.body);

    const separateAccount = await harness.authed(other, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'keyauth' },
    });
    assert.equal(separateAccount.statusCode, 201, separateAccount.body);
  });

  it('limits notification reads and leaves no-op reads unaudited', async () => {
    const initialAudit = await harness.store.auditLogs.list({ action: 'notification.read' });
    const first = await harness.authed(owner, {
      method: 'POST',
      url: '/api/notifications/read',
      payload: { all: true },
    });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json<MarkNotificationsReadResponse>().updated, 1);

    for (let attempt = 1; attempt < 60; attempt += 1) {
      const response = await harness.authed(owner, {
        method: 'POST',
        url: '/api/notifications/read',
        payload: { all: true },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json<MarkNotificationsReadResponse>().updated, 0);
    }

    const refused = await harness.authed(owner, {
      method: 'POST',
      url: '/api/notifications/read',
      payload: { all: true },
    });
    assert.equal(refused.statusCode, 429, refused.body);
    const finalAudit = await harness.store.auditLogs.list({ action: 'notification.read' });
    assert.equal(finalAudit.total, initialAudit.total + 1);

    const separateAccount = await harness.authed(other, {
      method: 'POST',
      url: '/api/notifications/read',
      payload: { all: true },
    });
    assert.equal(separateAccount.statusCode, 200, separateAccount.body);
  });
});
