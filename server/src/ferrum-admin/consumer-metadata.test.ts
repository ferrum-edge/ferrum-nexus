import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { consumerWithAclGroups } from './consumer-metadata.js';
import type { EdgeVerifiedConsumer } from './types.js';

function liveConsumer(overrides: Partial<EdgeVerifiedConsumer> = {}): EdgeVerifiedConsumer {
  return {
    id: 'consumer-1',
    username: 'nexus-user-1',
    namespace: 'nexus',
    custom_id: 'operator-custom',
    labels: { operator: 'retained' },
    credentials: { keyauth: [{ key: 'complete-key' }], custom: [{ opaque: true }] },
    acl_groups: ['operator-group', 'nexus:api:a:approved'],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    ...overrides,
  };
}

describe('consumerWithAclGroups', () => {
  it('replaces only acl_groups and carries every writable field over from the live row', () => {
    const live = liveConsumer();
    const body = consumerWithAclGroups(live, ['operator-group']);
    assert.deepEqual(body, {
      id: 'consumer-1',
      labels: { operator: 'retained' },
      username: 'nexus-user-1',
      custom_id: 'operator-custom',
      credentials: live.credentials,
      acl_groups: ['operator-group'],
    });
    // The credential-complete map is passed through untouched; the client's
    // replace() is what projects it for the metadata PUT.
    assert.equal(body.credentials, live.credentials);
    assert.deepEqual(live.acl_groups, ['operator-group', 'nexus:api:a:approved']);
  });

  it('never sends the read-only fields Edge rejects on write', () => {
    const body = consumerWithAclGroups(liveConsumer(), []);
    assert.deepEqual(Object.keys(body).sort(), [
      'acl_groups',
      'credentials',
      'custom_id',
      'id',
      'labels',
      'username',
    ]);
    assert.deepEqual(body.acl_groups, []);
  });

  it('sends custom_id as an explicit null when the live row has none', () => {
    const { custom_id: _omitted, ...withoutCustomId } = liveConsumer();
    assert.equal(consumerWithAclGroups(withoutCustomId, []).custom_id, null);
    assert.equal(consumerWithAclGroups(liveConsumer({ custom_id: null }), []).custom_id, null);
  });
});
