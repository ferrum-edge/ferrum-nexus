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
    assert.equal(lines[0], 'tag: contracts-edge-0.9.11');
    assert.equal(lines[1], 'commit: 390edbd5b2485af0988e02f7827fde778d76ae0a');

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
        'fixtures/backend-egress-policy/invalid/allow-overlay-guarantee.json',
        'fixtures/backend-egress-policy/invalid/false-public-guarantee.json',
        'fixtures/backend-egress-policy/invalid/leaked-cidr-field.json',
        'fixtures/backend-egress-policy/invalid/mode-class-mismatch.json',
        'fixtures/backend-egress-policy/invalid/unknown-classification.json',
        'fixtures/backend-egress-policy/invalid/unknown-enforcement-scope.json',
        'fixtures/backend-egress-policy/invalid/unknown-mode.json',
        'fixtures/backend-egress-policy/invalid/unknown-version.json',
        'fixtures/backend-egress-policy/invalid/wrong-evaluation-stage.json',
        'fixtures/backend-egress-policy/valid/default-control-plane.json',
        'fixtures/backend-egress-policy/valid/private-control-plane.json',
        'fixtures/backend-egress-policy/valid/public-serving.json',
        'fixtures/backend-egress-policy/valid/public-with-allow-overrides.json',
        'fixtures/invalid-expectations.json',
        'schemas/backend-egress-policy/v1.schema.json',
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
