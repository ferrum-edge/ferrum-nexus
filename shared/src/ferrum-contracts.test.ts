import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  FERRUM_PROVISIONED_BY_HEADER,
  FERRUM_PROVISIONED_BY_VALUE,
} from './constants.js';
import {
  FIRST_CLASS_PLUGIN_FIELDS,
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

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const contractsDirectory = join(repositoryRoot, 'contracts/ferrum-contracts');

function readContract<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(contractsDirectory, relativePath), 'utf8')) as T;
}

describe('pinned Ferrum contracts', () => {
  it('keeps every vendored contract file byte-identical to its recorded digest', () => {
    const pin = readFileSync(join(contractsDirectory, 'PIN'), 'utf8');
    const lines = pin.trim().split('\n');
    assert.equal(lines[0], 'tag: contracts-edge-0.9.8');
    assert.equal(lines[1], 'commit: 89ef3917ce6bba142dce50b84f2033d81eb429dd');

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
      ['vocabularies/plugin-catalog.json', 'vocabularies/provisioned-by.json'],
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
});
