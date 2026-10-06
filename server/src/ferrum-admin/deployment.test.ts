import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';

import {
  assertDeploymentApplied,
  assertDeploymentEvidence,
  deploymentSpecDocument,
  isDeploymentAcknowledgement,
  isDeploymentSnapshot,
} from './deployment.js';
import type { EdgeDeploymentAcknowledgement } from './types.js';

describe('published contracts-edge-0.9.12 deployment fixtures', () => {
  for (const contract of [
    { name: 'admin-deployment-snapshot', accepts: isDeploymentSnapshot },
    { name: 'admin-deployment-mutation-acknowledgement', accepts: isDeploymentAcknowledgement },
  ]) {
    for (const validity of ['valid', 'invalid']) {
      const directory = new URL(
        `../../../contracts/ferrum-contracts/fixtures/${contract.name}/${validity}/`,
        import.meta.url,
      );
      for (const file of readdirSync(directory)) {
        it(`${contract.name}: ${validity}/${file}`, () => {
          const value: unknown = JSON.parse(readFileSync(new URL(file, directory), 'utf8'));
          assert.equal(contract.accepts(value), validity === 'valid');
        });
      }
    }
  }

  it('does not treat an open JSON envelope as a certificate of original evidence', () => {
    const value: unknown = {
      profile: 'deployment-v1',
      namespace: 'nexus',
      namespace_etag: '"deployment-v1-00000000000000000000000000000000"',
      evidence: {},
      proxies: [],
      plugin_configs: [],
      upstreams: [],
      api_specs: [],
      future_owner_metadata: { retained: true },
    };
    assert.ok(isDeploymentSnapshot(value));
    assert.throws(
      () => assertDeploymentEvidence(value, 'nexus'),
      /cannot establish original authority/,
    );
  });

  it('requires applicable application and the exact profile/target before cleanup', () => {
    const acknowledgement: EdgeDeploymentAcknowledgement = {
      profile: 'deployment-v1',
      id: 'selected-proxy',
      durable: 'committed',
      live: 'applied',
      recovery_cleanup_authorized: true,
    };
    assertDeploymentApplied(acknowledgement, 'selected-proxy');
    assert.equal(
      isDeploymentAcknowledgement({ ...acknowledgement, durable: ['committed'] }),
      false,
    );
    assert.equal(isDeploymentAcknowledgement({ ...acknowledgement, live: ['applied'] }), false);
    assert.throws(() => assertDeploymentApplied(acknowledgement, 'another-proxy'), /unconfirmed/);
    assert.throws(
      () => assertDeploymentApplied({ ...acknowledgement, profile: undefined }, 'selected-proxy'),
      /unconfirmed/,
    );
    assert.throws(
      () =>
        assertDeploymentApplied(
          { ...acknowledgement, live: 'not_applicable', recovery_cleanup_authorized: false },
          'selected-proxy',
        ),
      /unconfirmed/,
    );
  });

  it('verifies stored gzip, size, digest and UTF-8 without projecting away unknown metadata', () => {
    const document = { openapi: '3.1.0', paths: {}, 'x-original-owner-field': { retained: true } };
    const bytes = Buffer.from(JSON.stringify(document));
    const original = {
      spec_format: 'json',
      content_encoding: 'gzip',
      spec_content: [...gzipSync(bytes)],
      uncompressed_size: bytes.length,
      content_hash: createHash('sha256').update(bytes).digest('hex'),
      external_ref_snapshot: [1, 2, 3],
      future_owner_field: { opaque: true },
    };
    const before = structuredClone(original);
    assert.deepEqual(deploymentSpecDocument(original), document);
    assert.deepEqual(original, before);
    for (const changed of [
      { ...original, uncompressed_size: bytes.length + 1 },
      { ...original, content_hash: '0'.repeat(64) },
      { ...original, spec_content: [256] },
      { ...original, spec_content: [0, 1, 2] },
    ]) {
      assert.throws(() => deploymentSpecDocument(changed), /cannot be verified/);
    }
  });
});
