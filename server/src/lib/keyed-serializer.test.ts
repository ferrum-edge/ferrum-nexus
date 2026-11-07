import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { apiRestoreLockKey, proxyLockKey } from './keyed-serializer.js';

describe('proxyLockKey', () => {
  it('spells the persisted proxy lease key exactly', () => {
    // The string names an `edge_leases` row every Nexus instance contends on,
    // so during a rolling deploy an old and a new instance must agree on it.
    // Changing it would let publishing and access decisions run concurrently.
    assert.equal(
      proxyLockKey('8c1f4a52-3b8e-4c8f-9d1a-2f6b7e0c9a11'),
      'proxy:8c1f4a52-3b8e-4c8f-9d1a-2f6b7e0c9a11',
    );
  });

  it('stays distinct from the neighbouring per-API and consumer keys', () => {
    const id = '8c1f4a52-3b8e-4c8f-9d1a-2f6b7e0c9a11';
    // The restore key is deliberately not a proxy key (there may be no proxy),
    // the palette key guards palette writes only, and consumer writes take the
    // bare consumer id.
    assert.notEqual(proxyLockKey(id), apiRestoreLockKey(id));
    assert.notEqual(proxyLockKey(id), `proxy-palette:${id}`);
    assert.notEqual(proxyLockKey(id), id);
  });
});
