import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  FERRUM_NAMESPACE_HEADER,
  FERRUM_NAMESPACE_UNSERVED_HEADER,
  FERRUM_PROVISIONED_BY_HEADER,
  FERRUM_PROVISIONED_BY_VALUE,
} from './constants.js';
import {
  FIRST_CLASS_PLUGIN_FIELDS,
  isGatewayOwnedConsumerHeader,
  PLUGIN_CATEGORIES,
  PROVIDER_PLUGINS,
  RETIRED_RESPONSE_CACHING,
} from './plugins.js';

interface PluginCatalogContract {
  plugins: { name: string }[];
  removed_plugins: { name: string }[];
}

interface ProvisionedByContract {
  header: { name: string };
  values: { value: string; product: string; sets: string }[];
}

interface GatewayHeadersContract {
  headers: { name: string }[];
}

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const contractsDirectory = join(repositoryRoot, 'contracts/ferrum-contracts');

function readContract<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(contractsDirectory, relativePath), 'utf8')) as T;
}

describe('pinned Ferrum contracts', () => {
  it('keeps every vendored contract file byte-identical to its recorded digest', () => {
    const pin = readFileSync(join(contractsDirectory, 'PIN'), 'utf8');
    const lines = pin.trim().split('\n');
    assert.equal(lines[0], 'tag: contracts-edge-0.9.14');
    assert.equal(lines[1], 'commit: ddbdd845733b7046c4393ac951011dafb774db33');

    const digestLines = lines.slice(2);
    assert.ok(digestLines.length > 0, 'PIN must list the vendored contract file digests');
    for (const line of digestLines) {
      const match = /^sha256: ([a-f0-9]{64})  ([\w./-]+)$/.exec(line);
      assert.ok(match, `Invalid digest line in PIN: ${line}`);
      const expectedDigest = match[1];
      const relativePath = match[2];
      assert.ok(expectedDigest, `PIN digest is missing: ${line}`);
      assert.ok(relativePath, `PIN path is missing: ${line}`);
      assert.ok(
        !relativePath.split('/').includes('..'),
        `PIN path escapes the contract directory: ${line}`,
      );
      const bytes = readFileSync(join(contractsDirectory, relativePath));
      const actualDigest = createHash('sha256').update(bytes).digest('hex');
      assert.equal(actualDigest, expectedDigest, `${relativePath} differs from PIN`);
    }

    assert.deepEqual(
      digestLines.map((line) => line.replace(/^sha256: [a-f0-9]{64}  /, '')).sort(),
      [
        'fixtures/admin-deployment-mutation-acknowledgement/invalid/cleanup-not-boolean.json',
        'fixtures/admin-deployment-mutation-acknowledgement/invalid/durable-only-cleanup.json',
        'fixtures/admin-deployment-mutation-acknowledgement/invalid/missing-cleanup-authorization.json',
        'fixtures/admin-deployment-mutation-acknowledgement/invalid/unconfirmed-cleanup.json',
        'fixtures/admin-deployment-mutation-acknowledgement/invalid/unknown-durable-cleanup.json',
        'fixtures/admin-deployment-mutation-acknowledgement/invalid/unknown-durable.json',
        'fixtures/admin-deployment-mutation-acknowledgement/invalid/unknown-live.json',
        'fixtures/admin-deployment-mutation-acknowledgement/invalid/unknown-profile.json',
        'fixtures/admin-deployment-mutation-acknowledgement/valid/applied.json',
        'fixtures/admin-deployment-mutation-acknowledgement/valid/committed-unconfirmed.json',
        'fixtures/admin-deployment-mutation-acknowledgement/valid/durable-only.json',
        'fixtures/admin-deployment-mutation-acknowledgement/valid/not-started.json',
        'fixtures/admin-deployment-mutation-acknowledgement/valid/snapshot-too-large-not-committed.json',
        'fixtures/admin-deployment-mutation-acknowledgement/valid/snapshot-too-large-not-started.json',
        'fixtures/admin-deployment-mutation-acknowledgement/valid/stale.json',
        'fixtures/admin-deployment-mutation-acknowledgement/valid/store-failure-not-committed.json',
        'fixtures/admin-deployment-mutation-acknowledgement/valid/unknown.json',
        'fixtures/admin-deployment-snapshot/v1/invalid/evidence-not-object.json',
        'fixtures/admin-deployment-snapshot/v1/invalid/missing-evidence.json',
        'fixtures/admin-deployment-snapshot/v1/invalid/row-token.json',
        'fixtures/admin-deployment-snapshot/v1/invalid/spec-not-object.json',
        'fixtures/admin-deployment-snapshot/v1/invalid/token-list.json',
        'fixtures/admin-deployment-snapshot/v1/invalid/token-with-line-break.json',
        'fixtures/admin-deployment-snapshot/v1/invalid/unknown-profile.json',
        'fixtures/admin-deployment-snapshot/v1/invalid/weak-token.json',
        'fixtures/admin-deployment-snapshot/v1/valid/empty-mongodb.json',
        'fixtures/admin-deployment-snapshot/v1/valid/empty-sql.json',
        'fixtures/admin-deployment-snapshot/v2/invalid/evidence-not-object.json',
        'fixtures/admin-deployment-snapshot/v2/invalid/external-ref-byte-array.json',
        'fixtures/admin-deployment-snapshot/v2/invalid/missing-api-spec-contents.json',
        'fixtures/admin-deployment-snapshot/v2/invalid/missing-evidence.json',
        'fixtures/admin-deployment-snapshot/v2/invalid/row-token.json',
        'fixtures/admin-deployment-snapshot/v2/invalid/spec-content-byte-array.json',
        'fixtures/admin-deployment-snapshot/v2/invalid/spec-contents-base64-byte-array.json',
        'fixtures/admin-deployment-snapshot/v2/invalid/spec-contents-external-ref-byte-array.json',
        'fixtures/admin-deployment-snapshot/v2/invalid/spec-contents-extra-member.json',
        'fixtures/admin-deployment-snapshot/v2/invalid/spec-contents-missing-external-ref.json',
        'fixtures/admin-deployment-snapshot/v2/invalid/spec-contents-numeric-id.json',
        'fixtures/admin-deployment-snapshot/v2/invalid/spec-digest-extra-member.json',
        'fixtures/admin-deployment-snapshot/v2/invalid/spec-digest-missing-len.json',
        'fixtures/admin-deployment-snapshot/v2/invalid/spec-digest-negative-len.json',
        'fixtures/admin-deployment-snapshot/v2/invalid/spec-digest-sha256-byte-array.json',
        'fixtures/admin-deployment-snapshot/v2/invalid/spec-digest-string-len.json',
        'fixtures/admin-deployment-snapshot/v2/invalid/spec-digest-uppercase-sha256.json',
        'fixtures/admin-deployment-snapshot/v2/invalid/spec-missing-proxy-id.json',
        'fixtures/admin-deployment-snapshot/v2/invalid/spec-not-object.json',
        'fixtures/admin-deployment-snapshot/v2/invalid/token-list.json',
        'fixtures/admin-deployment-snapshot/v2/invalid/token-with-line-break.json',
        'fixtures/admin-deployment-snapshot/v2/invalid/unknown-profile.json',
        'fixtures/admin-deployment-snapshot/v2/invalid/weak-token.json',
        'fixtures/admin-deployment-snapshot/v2/valid/empty-mongodb.json',
        'fixtures/admin-deployment-snapshot/v2/valid/empty-sql.json',
        'fixtures/admin-deployment-snapshot/v2/valid/one-spec-sql.json',
        'fixtures/backend-egress-policy/v1/invalid/allow-overlay-guarantee.json',
        'fixtures/backend-egress-policy/v1/invalid/false-public-guarantee.json',
        'fixtures/backend-egress-policy/v1/invalid/leaked-cidr-field.json',
        'fixtures/backend-egress-policy/v1/invalid/mode-class-mismatch.json',
        'fixtures/backend-egress-policy/v1/invalid/unknown-classification.json',
        'fixtures/backend-egress-policy/v1/invalid/unknown-enforcement-scope.json',
        'fixtures/backend-egress-policy/v1/invalid/unknown-mode.json',
        'fixtures/backend-egress-policy/v1/invalid/unknown-version.json',
        'fixtures/backend-egress-policy/v1/invalid/wrong-evaluation-stage.json',
        'fixtures/backend-egress-policy/v1/valid/default-control-plane.json',
        'fixtures/backend-egress-policy/v1/valid/private-control-plane.json',
        'fixtures/backend-egress-policy/v1/valid/public-serving.json',
        'fixtures/backend-egress-policy/v1/valid/public-with-allow-overrides.json',
        'fixtures/backend-egress-policy/v2/invalid/admission-only-guarantee.json',
        'fixtures/backend-egress-policy/v2/invalid/allow-overlay-guarantee.json',
        'fixtures/backend-egress-policy/v2/invalid/attestation-leaked-cidr-field.json',
        'fixtures/backend-egress-policy/v2/invalid/attestation-missing-data-planes.json',
        'fixtures/backend-egress-policy/v2/invalid/attestation-negative-count.json',
        'fixtures/backend-egress-policy/v2/invalid/attestation-on-local-data-plane.json',
        'fixtures/backend-egress-policy/v2/invalid/attestation-unknown-source.json',
        'fixtures/backend-egress-policy/v2/invalid/empty-set-complete.json',
        'fixtures/backend-egress-policy/v2/invalid/entry-build-version.json',
        'fixtures/backend-egress-policy/v2/invalid/entry-connected-at-without-offset.json',
        'fixtures/backend-egress-policy/v2/invalid/entry-policy-allow-overlay-guarantee.json',
        'fixtures/backend-egress-policy/v2/invalid/entry-policy-false-public-guarantee.json',
        'fixtures/backend-egress-policy/v2/invalid/entry-policy-leaked-cidr-field.json',
        'fixtures/backend-egress-policy/v2/invalid/entry-policy-mode-class-mismatch.json',
        'fixtures/backend-egress-policy/v2/invalid/entry-reported-without-policy.json',
        'fixtures/backend-egress-policy/v2/invalid/entry-unknown-attestation.json',
        'fixtures/backend-egress-policy/v2/invalid/entry-unknown-with-policy.json',
        'fixtures/backend-egress-policy/v2/invalid/false-public-guarantee.json',
        'fixtures/backend-egress-policy/v2/invalid/guarantee-with-allow-overlay.json',
        'fixtures/backend-egress-policy/v2/invalid/guarantee-with-unknown-data-plane.json',
        'fixtures/backend-egress-policy/v2/invalid/leaked-cidr-field.json',
        'fixtures/backend-egress-policy/v2/invalid/mode-class-mismatch.json',
        'fixtures/backend-egress-policy/v2/invalid/no-data-plane-guarantee.json',
        'fixtures/backend-egress-policy/v2/invalid/previous-version.json',
        'fixtures/backend-egress-policy/v2/invalid/public-only-not-aggregated.json',
        'fixtures/backend-egress-policy/v2/invalid/reports-without-weakest-policy.json',
        'fixtures/backend-egress-policy/v2/invalid/unknown-classification.json',
        'fixtures/backend-egress-policy/v2/invalid/unknown-enforcement-scope.json',
        'fixtures/backend-egress-policy/v2/invalid/unknown-mode.json',
        'fixtures/backend-egress-policy/v2/invalid/unknown-version.json',
        'fixtures/backend-egress-policy/v2/invalid/unserved-namespace-guarantee.json',
        'fixtures/backend-egress-policy/v2/invalid/weakest-policy-unknown-mode.json',
        'fixtures/backend-egress-policy/v2/invalid/weakest-policy-without-reports.json',
        'fixtures/backend-egress-policy/v2/invalid/wrong-evaluation-stage.json',
        'fixtures/backend-egress-policy/v2/valid/control-plane-attestation-allow-overlay.json',
        'fixtures/backend-egress-policy/v2/valid/control-plane-attestation-empty.json',
        'fixtures/backend-egress-policy/v2/valid/control-plane-attestation-reported.json',
        'fixtures/backend-egress-policy/v2/valid/control-plane-attestation-shared-node-id.json',
        'fixtures/backend-egress-policy/v2/valid/control-plane-attestation-unknown.json',
        'fixtures/backend-egress-policy/v2/valid/default-control-plane.json',
        'fixtures/backend-egress-policy/v2/valid/private-control-plane.json',
        'fixtures/backend-egress-policy/v2/valid/public-control-plane.json',
        'fixtures/backend-egress-policy/v2/valid/public-no-data-plane.json',
        'fixtures/backend-egress-policy/v2/valid/public-serving.json',
        'fixtures/backend-egress-policy/v2/valid/public-unserved-namespace.json',
        'fixtures/backend-egress-policy/v2/valid/public-with-allow-overrides.json',
        'fixtures/invalid-expectations.json',
        'schemas/admin-deployment-mutation-acknowledgement/v1.schema.json',
        'schemas/admin-deployment-snapshot/v1.schema.json',
        'schemas/admin-deployment-snapshot/v2.schema.json',
        'schemas/backend-egress-policy/v1.schema.json',
        'schemas/backend-egress-policy/v2.schema.json',
        'vocabularies/backend-egress-policy.json',
        'vocabularies/gateway-errors.json',
        'vocabularies/gateway-headers.json',
        'vocabularies/plugin-catalog.json',
        'vocabularies/provisioned-by.json',
      ],
      'PIN must cover exactly the vendored contracts adopted by Nexus',
    );
  });

  it('keeps Nexus plugin names within the pinned Edge catalog', () => {
    const catalog = readContract<PluginCatalogContract>('vocabularies/plugin-catalog.json');
    const contractNames = new Set([
      ...catalog.plugins.map(({ name }) => name),
      ...catalog.removed_plugins.map(({ name }) => name),
    ]);
    const localNames = [
      ...PROVIDER_PLUGINS.map(({ name }) => name),
      RETIRED_RESPONSE_CACHING.name,
      ...Object.keys(FIRST_CLASS_PLUGIN_FIELDS),
    ];
    const duplicateNames = localNames.filter((name, index) => localNames.indexOf(name) !== index);
    const missingNames = [...new Set(localNames.filter((name) => !contractNames.has(name)))].sort();
    const usedCategories = [...new Set(PROVIDER_PLUGINS.map(({ category }) => category))].sort();
    const declaredCategories = [...PLUGIN_CATEGORIES].sort();
    const missingCategories = usedCategories.filter(
      (category) => !declaredCategories.includes(category),
    );

    assert.deepEqual(
      duplicateNames,
      [],
      `Duplicate local plugin names: ${duplicateNames.join(', ')}`,
    );
    assert.deepEqual(
      missingNames,
      [],
      `Local plugin names absent from the pinned contract: ${missingNames.join(', ')}`,
    );
    assert.deepEqual(
      missingCategories,
      [],
      `Provider plugin categories missing from the category catalog: ` +
        missingCategories.join(', '),
    );

    // This Edge vocabulary records schema pointers, not config property lists. The
    // provider field keys remain the exact Edge keys in PROVIDER_PLUGINS; no config
    // field names are duplicated by this pinned vocabulary to compare here.
  });

  it('keeps Nexus provisioning attribution aligned with the pinned vocabulary', () => {
    const contract = readContract<ProvisionedByContract>('vocabularies/provisioned-by.json');
    assert.equal(FERRUM_PROVISIONED_BY_HEADER.toLowerCase(), contract.header.name.toLowerCase());
    assert.ok(
      contract.values.some(
        ({ value, product, sets }) =>
          value === FERRUM_PROVISIONED_BY_VALUE && product === 'Nexus' && sets === 'header',
      ),
      `Nexus value '${FERRUM_PROVISIONED_BY_VALUE}' is absent from the pinned header values`,
    );
  });

  it('keeps the gateway headers Nexus speaks in the pinned vocabulary', () => {
    const { headers } = readContract<GatewayHeadersContract>('vocabularies/gateway-headers.json');
    const names = headers.map(({ name }) => name.toLowerCase());

    for (const header of [FERRUM_NAMESPACE_HEADER, FERRUM_NAMESPACE_UNSERVED_HEADER]) {
      assert.ok(
        names.includes(header.toLowerCase()),
        `Nexus header '${header}' is absent from the pinned gateway-headers vocabulary`,
      );
    }

    // The gateway owns the whole `x-consumer-*` namespace. The vocabulary
    // records it as a `prefix` entry that the shared matcher must recognize.
    assert.ok(
      headers.some(({ name }) => isGatewayOwnedConsumerHeader(name)),
      'The pinned gateway-headers vocabulary declares no gateway-owned x-consumer-* header',
    );
  });
});
