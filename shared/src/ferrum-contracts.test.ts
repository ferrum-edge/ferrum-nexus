import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
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

const PIN_TAG_LINE = /^tag (contracts-edge-[0-9]+\.[0-9]+\.[0-9]+(?:-r(?:[2-9]|[1-9][0-9]+))?)$/;
const PIN_COMMIT_LINE = /^commit ([0-9a-f]{40})$/;
const PIN_EDGE_VERSION_LINE = /^edge_version (v[0-9]+\.[0-9]+\.[0-9]+)$/;
const PIN_ROW_LINE = /^([0-9a-f]{64})  (\S+)$/;
const PIN_PATH_SEGMENT = /^(?!\.\.?$)[A-Za-z0-9._-]+$/;
const ASCII_ONLY = /^[\x00-\x7f]*$/;
const PIN_INVALID = /^Error: PIN /;
const NOT_A_REGULAR_FILE = /neither a regular file nor a directory/;

interface PinRow {
  digest: string;
  path: string;
}

interface ParsedPin {
  tag: string;
  commit: string;
  edgeVersion: string | null;
  rows: PinRow[];
}

/** Byte order, the order consumer-pins.md sorts paths in (ASCII-only paths). */
function byteOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function pinError(message: string): Error {
  return new Error(`PIN ${message}`);
}

/**
 * Parse `PIN` strictly, as ferrum-contracts `docs/consumer-pins.md` defines it
 * (checks 1 to 3): ASCII and LF only with a final newline, `tag` then `commit`
 * then an optional `edge_version`, then at least one `<sha256>  <path>` row,
 * paths valid and strictly ascending in byte order. Any other line fails.
 */
function parsePin(text: string): ParsedPin {
  if (!ASCII_ONLY.test(text)) throw pinError('must be ASCII');
  if (text.includes('\r')) throw pinError('must not contain a carriage return');
  if (!text.endsWith('\n')) throw pinError('must end with a newline');
  const lines = text.slice(0, -1).split('\n');
  const tag = PIN_TAG_LINE.exec(lines[0] ?? '')?.[1];
  if (tag === undefined) throw pinError(`line 1 must be "tag <tag>": ${lines[0] ?? ''}`);
  const commit = PIN_COMMIT_LINE.exec(lines[1] ?? '')?.[1];
  if (commit === undefined) throw pinError(`line 2 must be "commit <sha>": ${lines[1] ?? ''}`);
  const edgeVersion = PIN_EDGE_VERSION_LINE.exec(lines[2] ?? '')?.[1] ?? null;
  const rowLines = lines.slice(edgeVersion === null ? 2 : 3);
  if (rowLines.length === 0) throw pinError('must list at least one file');
  const rows = rowLines.map((line, index): PinRow => {
    const match = PIN_ROW_LINE.exec(line);
    const [, digest, path] = match ?? [];
    if (digest === undefined || path === undefined) {
      throw pinError(`row ${index + 1} is not "<sha256>  <path>": ${line}`);
    }
    if (path === 'PIN' || !path.split('/').every((segment) => PIN_PATH_SEGMENT.test(segment))) {
      throw pinError(`row ${index + 1} has an invalid path: ${path}`);
    }
    return { digest, path };
  });
  rows.forEach((row, index) => {
    const previous = rows[index - 1];
    if (previous && byteOrder(previous.path, row.path) >= 0) {
      throw pinError(`rows must be strictly ascending by path: ${previous.path}, ${row.path}`);
    }
  });
  return { tag, commit, edgeVersion, rows };
}

/**
 * Every file under `root` other than its top-level `PIN`, as `/`-separated
 * relative paths in byte order. Anything that is neither a regular file nor a
 * directory (a symbolic link included) fails, per consumer-pins.md check 4.
 */
function vendoredFiles(root: string, prefix = ''): string[] {
  const files: string[] = [];
  for (const name of readdirSync(join(root, prefix))) {
    const relative = prefix === '' ? name : `${prefix}/${name}`;
    const stats = lstatSync(join(root, relative));
    if (stats.isDirectory()) {
      files.push(...vendoredFiles(root, relative));
    } else if (!stats.isFile()) {
      throw new Error(`${relative} is neither a regular file nor a directory`);
    } else if (relative !== 'PIN') {
      files.push(relative);
    }
  }
  return prefix === '' ? files.sort(byteOrder) : files;
}

interface PluginCatalogContract {
  plugins: { name: string }[];
  removed_plugins: { name: string }[];
}

interface ProvisionedByContract {
  header: { name: string };
  values: { value: string; product: string; sets: string }[];
}

interface GatewayHeadersContract {
  headers: { name: string; match?: string; role?: string; availability?: string }[];
}

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const contractsDirectory = join(repositoryRoot, 'contracts/ferrum-contracts');

function readContract<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(contractsDirectory, relativePath), 'utf8')) as T;
}

describe('pinned Ferrum contracts', () => {
  it('parses PIN under the consumer-pins.md rules', () => {
    const pin = parsePin(readFileSync(join(contractsDirectory, 'PIN'), 'utf8'));
    assert.equal(pin.tag, 'contracts-edge-0.9.21');
    assert.equal(pin.commit, '92d8da5be93ea1ece9f47729b1f7aa10ae8a7c3f');
    assert.equal(pin.edgeVersion, null);
  });

  it('keeps exactly one PIN row per vendored file, and every file byte-identical to it', () => {
    const pin = parsePin(readFileSync(join(contractsDirectory, 'PIN'), 'utf8'));
    // Check 4, tree equality: the rows name exactly the files on disk.
    assert.deepEqual(
      pin.rows.map(({ path }) => path),
      vendoredFiles(contractsDirectory),
      'PIN rows must name exactly the files under contracts/ferrum-contracts/',
    );
    // Check 5, content.
    for (const { digest, path } of pin.rows) {
      const bytes = readFileSync(join(contractsDirectory, path));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), digest, `${path} differs`);
    }
  });

  it('refuses the PIN shapes consumer-pins.md forbids', () => {
    const hash = 'a'.repeat(64);
    const head = 'tag contracts-edge-0.9.20\ncommit ' + 'b'.repeat(40) + '\n';
    const valid = `${head}${hash}  a-b/x.json\n${hash}  a/x.json\n`;
    assert.equal(parsePin(valid).rows.length, 2);
    const versioned = `${head}edge_version v0.9.20\n${hash}  a.json\n`;
    assert.equal(parsePin(versioned).edgeVersion, 'v0.9.20');
    for (const [name, text] of [
      ['old colon headers', `tag: contracts-edge-0.9.20\ncommit: ${'b'.repeat(40)}\n`],
      ['missing final newline', valid.slice(0, -1)],
      ['carriage return', `${head}${hash}  a.json\r\n`],
      ['blank line', `${head}\n${hash}  a.json\n`],
      ['no rows', head],
      ['headers out of order', `commit ${'b'.repeat(40)}\ntag contracts-edge-0.9.20\n`],
      ['revision 1 tag', valid.replace('0.9.20', '0.9.20-r1')],
      ['short commit', valid.replace('b'.repeat(40), 'b'.repeat(39))],
      ['uppercase hash', `${head}${'A'.repeat(64)}  a.json\n`],
      ['one space', `${head}${hash} a.json\n`],
      ['three spaces', `${head}${hash}   a.json\n`],
      ['old sha256 prefix', `${head}sha256: ${hash}  a.json\n`],
      ['dot segment', `${head}${hash}  a/../b.json\n`],
      ['empty segment', `${head}${hash}  a//b.json\n`],
      ['leading slash', `${head}${hash}  /a.json\n`],
      ['lists PIN', `${head}${hash}  PIN\n`],
      ['unsorted', `${head}${hash}  a/x.json\n${hash}  a-b/x.json\n`],
      ['duplicate', `${head}${hash}  a.json\n${hash}  a.json\n`],
      ['trailing space', `${head}${hash}  a.json \n`],
    ] as const) {
      assert.throws(() => parsePin(text), PIN_INVALID, name);
    }
  });

  it('finds every vendored file, and refuses a symbolic link', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'nexus-pin-'));
    try {
      mkdirSync(join(scratch, 'schemas', 'one'), { recursive: true });
      writeFileSync(join(scratch, 'PIN'), '');
      writeFileSync(join(scratch, 'schemas', 'one', 'v1.schema.json'), '{}');
      writeFileSync(join(scratch, 'unpinned.json'), '{}');
      assert.deepEqual(vendoredFiles(scratch), ['schemas/one/v1.schema.json', 'unpinned.json']);
      symlinkSync('unpinned.json', join(scratch, 'linked.json'));
      assert.throws(() => vendoredFiles(scratch), NOT_A_REGULAR_FILE);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
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

    // Edge v0.9.15 sends an external identity as the exact, gateway-owned
    // `X-Authenticated-Identity`, which shares the `x-consumer-*` check.
    const identity = headers.find(({ name }) => name.toLowerCase() === 'x-authenticated-identity');
    assert.ok(identity, 'The pinned gateway-headers vocabulary has no X-Authenticated-Identity');
    assert.equal(identity.match, 'exact');
    assert.equal(identity.role, 'gateway_assertion');
    assert.equal(isGatewayOwnedConsumerHeader(identity.name), true);
  });
});
