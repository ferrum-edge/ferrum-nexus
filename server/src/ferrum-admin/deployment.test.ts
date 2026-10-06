import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';

import { isNexusError } from '../lib/errors.js';
import {
  assertDeploymentApplied,
  assertDeploymentEvidence,
  deploymentSpecDocument,
  isDeploymentAcknowledgement,
  isDeploymentSnapshot,
  isLegacyDeploymentSnapshot,
  isSnapshotTooLargeRefusal,
} from './deployment.js';
import type { EdgeDeploymentAcknowledgement, EdgeDeploymentSnapshot } from './types.js';

const contracts = new URL('../../../contracts/ferrum-contracts/', import.meta.url);

function fixture<T>(path: string): T {
  return JSON.parse(readFileSync(new URL(path, contracts), 'utf8')) as T;
}

function legacyRefusal(error: unknown): boolean {
  assert.ok(isNexusError(error));
  assert.equal(error.code, 'CONFLICT');
  assert.deepEqual(error.details, { kind: 'legacy_deployment_authority' });
  return true;
}

/** A complete v2 snapshot holding one stored spec, with its bytes in api_spec_contents. */
function oneSpecSnapshot(document: Record<string, unknown>): EdgeDeploymentSnapshot {
  const snapshot = fixture<EdgeDeploymentSnapshot>(
    'fixtures/admin-deployment-snapshot/v2/valid/one-spec-sql.json',
  );
  const bytes = Buffer.from(JSON.stringify(document));
  const stored = gzipSync(bytes);
  const original = snapshot.api_specs[0] as unknown as Record<string, unknown>;
  const spec = {
    ...original,
    spec_content: {
      sha256: createHash('sha256').update(stored).digest('hex'),
      len: stored.length,
    },
    uncompressed_size: bytes.length,
    content_hash: createHash('sha256').update(bytes).digest('hex'),
    future_owner_field: { opaque: true },
  };
  snapshot.api_specs = [spec];
  (snapshot.evidence.resources as unknown[])[5] = [structuredClone(spec)];
  snapshot.api_spec_contents = [
    {
      id: String(original['id']),
      spec_content_base64: stored.toString('base64'),
      external_ref_snapshot_base64: null,
    },
  ];
  return snapshot;
}

describe('published contracts-edge-0.9.13 deployment fixtures', () => {
  for (const contract of [
    { name: 'admin-deployment-snapshot/v2', accepts: isDeploymentSnapshot },
    { name: 'admin-deployment-mutation-acknowledgement', accepts: isDeploymentAcknowledgement },
  ]) {
    for (const validity of ['valid', 'invalid']) {
      const directory = new URL(`fixtures/${contract.name}/${validity}/`, contracts);
      for (const file of readdirSync(directory)) {
        it(`${contract.name}: ${validity}/${file}`, () => {
          const value: unknown = JSON.parse(readFileSync(new URL(file, directory), 'utf8'));
          assert.equal(contract.accepts(value), validity === 'valid');
        });
      }
    }
  }

  it('recognizes Edge v0.9.12 (v1) snapshots only as legacy authority', () => {
    for (const file of ['empty-sql.json', 'empty-mongodb.json']) {
      const legacy = fixture<EdgeDeploymentSnapshot>(
        `fixtures/admin-deployment-snapshot/v1/valid/${file}`,
      );
      assert.equal(isDeploymentSnapshot(legacy), false, file);
      assert.equal(isLegacyDeploymentSnapshot(legacy), true, file);
      assert.throws(() => assertDeploymentEvidence(legacy, legacy.namespace), legacyRefusal);
      assert.throws(() => deploymentSpecDocument(legacy, {}), legacyRefusal);
      const current = fixture<EdgeDeploymentSnapshot>(
        `fixtures/admin-deployment-snapshot/v2/valid/${file}`,
      );
      assert.equal(isLegacyDeploymentSnapshot(current), false, file);
      assertDeploymentEvidence(current, current.namespace);
    }
  });

  it('treats only a not-committed 507 acknowledgement as a definite refusal', () => {
    for (const file of [
      'snapshot-too-large-not-started.json',
      'snapshot-too-large-not-committed.json',
    ]) {
      const value = fixture<Record<string, unknown>>(
        `fixtures/admin-deployment-mutation-acknowledgement/valid/${file}`,
      );
      assert.equal(isSnapshotTooLargeRefusal(value), true, file);
    }
    const refusal = {
      durable: 'not_committed',
      live: 'unconfirmed',
      recovery_cleanup_authorized: false,
    };
    for (const uncertain of [
      { ...refusal, durable: 'unknown' },
      { ...refusal, durable: 'committed' },
      { ...refusal, live: 'applied' },
      { ...refusal, recovery_cleanup_authorized: 'false' },
      { error: 'Insufficient Storage' },
      null,
    ]) {
      assert.equal(isSnapshotTooLargeRefusal(uncertain), false);
    }
  });

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
      api_spec_contents: [],
      future_owner_metadata: { retained: true },
    };
    assert.ok(isDeploymentSnapshot(value));
    assert.throws(
      () => assertDeploymentEvidence(value, 'nexus'),
      /cannot establish original authority/,
    );
  });

  it('verifies every api_spec_contents entry against the digest the token fences', () => {
    const document = { openapi: '3.1.0', paths: {} };
    const valid = oneSpecSnapshot(document);
    assertDeploymentEvidence(valid, valid.namespace);
    const published = fixture<EdgeDeploymentSnapshot>(
      'fixtures/admin-deployment-snapshot/v2/valid/one-spec-sql.json',
    );
    assertDeploymentEvidence(published, published.namespace);
    assert.deepEqual(deploymentSpecDocument(published, published.api_specs[0]!), {
      openapi: '3.1.0',
      info: { title: 'Fixture', version: '1.0.0' },
      paths: {},
    });
    const tampered: ((snapshot: EdgeDeploymentSnapshot) => void)[] = [
      (snapshot) => {
        snapshot.api_spec_contents = [];
      },
      (snapshot) => {
        snapshot.api_spec_contents[0]!.id = 'another-spec';
      },
      (snapshot) => {
        const changed = gzipSync(Buffer.from('{}'));
        snapshot.api_spec_contents[0]!.spec_content_base64 = changed.toString('base64');
      },
      (snapshot) => {
        // Valid bytes, but not the canonical padded encoding Edge emits.
        snapshot.api_spec_contents[0]!.spec_content_base64 += '\n';
      },
      (snapshot) => {
        snapshot.api_spec_contents[0]!.external_ref_snapshot_base64 = '';
      },
      (snapshot) => {
        snapshot.api_spec_contents.push({ ...snapshot.api_spec_contents[0]! });
      },
      (snapshot) => {
        // Top-level api_specs must equal evidence.resources[5] exactly.
        snapshot.api_specs = [{ ...snapshot.api_specs[0]!, title: 'Changed' }];
      },
    ];
    for (const tamper of tampered) {
      const snapshot = structuredClone(valid);
      tamper(snapshot);
      assert.throws(
        () => assertDeploymentEvidence(snapshot, snapshot.namespace),
        /cannot establish original authority/,
      );
    }
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
    const snapshot = oneSpecSnapshot(document);
    const original = snapshot.api_specs[0]!;
    const before = structuredClone(snapshot);
    assert.deepEqual(deploymentSpecDocument(snapshot, original), document);
    assert.deepEqual(snapshot, before);
    const digest = original.spec_content as { sha256: string; len: number };
    for (const changed of [
      { ...original, uncompressed_size: Number(original.uncompressed_size) + 1 },
      { ...original, content_hash: '0'.repeat(64) },
      { ...original, spec_content: { ...digest, len: digest.len + 1 } },
      { ...original, spec_content: { ...digest, sha256: '0'.repeat(64) } },
      { ...original, spec_content: [...gzipSync(Buffer.from(JSON.stringify(document)))] },
      { ...original, id: 'unlisted-spec' },
      { ...original, content_encoding: 'identity' },
    ]) {
      assert.throws(() => deploymentSpecDocument(snapshot, changed), /cannot be verified/);
    }
  });
});
