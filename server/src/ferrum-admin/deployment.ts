/**
 * Released Edge v0.9.13 deployment authority (contracts `admin-deployment-snapshot` v2);
 * never derive or refresh its keyed token.
 */
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { isDeepStrictEqual } from 'node:util';
import { parseDocument } from 'yaml';

import { conflict, edgeError, type NexusError } from '../lib/errors.js';
import type {
  EdgeDeploymentAcknowledgement,
  EdgeDeploymentSnapshot,
  EdgeDeploymentSpecContents,
  EdgePluginConfig,
  EdgeProxy,
  EdgeStoredContentDigest,
} from './types.js';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function isDeploymentTag(value: unknown): value is string {
  return typeof value === 'string' && /^"deployment-v1-[0-9a-f]{32}"(?![\s\S])/.test(value);
}

/** `StoredContentDigest`: the snapshot's stand-in for stored bytes. */
function isStoredDigest(value: unknown): value is EdgeStoredContentDigest {
  return (
    record(value) &&
    exactKeys(value, ['sha256', 'len']) &&
    typeof value.sha256 === 'string' &&
    SHA256_HEX.test(value.sha256) &&
    Number.isSafeInteger(value.len) &&
    Number(value.len) >= 0
  );
}

/** The closed `api_spec_contents` item. */
function isSpecContents(value: unknown): value is EdgeDeploymentSpecContents {
  return (
    record(value) &&
    exactKeys(value, ['id', 'spec_content_base64', 'external_ref_snapshot_base64']) &&
    typeof value.id === 'string' &&
    typeof value.spec_content_base64 === 'string' &&
    (value.external_ref_snapshot_base64 === null ||
      typeof value.external_ref_snapshot_base64 === 'string')
  );
}

/** The envelope both snapshot majors share. */
function isSnapshotEnvelope(value: unknown): value is Record<string, unknown> {
  return (
    record(value) &&
    value.profile === 'deployment-v1' &&
    typeof value.namespace === 'string' &&
    isDeploymentTag(value.namespace_etag) &&
    record(value.evidence) &&
    ['proxies', 'plugin_configs', 'upstreams', 'api_specs'].every((field) => {
      const rows = value[field];
      return Array.isArray(rows) && rows.every(record);
    })
  );
}

/** Envelope validation is not a certificate of complete raw SQL/BSON evidence. */
export function isDeploymentSnapshot(value: unknown): value is EdgeDeploymentSnapshot {
  return (
    isSnapshotEnvelope(value) &&
    (value.api_specs as Record<string, unknown>[]).every(
      (spec) =>
        typeof spec.id === 'string' &&
        typeof spec.proxy_id === 'string' &&
        isStoredDigest(spec.spec_content) &&
        (spec.external_ref_snapshot === undefined ||
          spec.external_ref_snapshot === null ||
          isStoredDigest(spec.external_ref_snapshot)),
    ) &&
    Array.isArray(value.api_spec_contents) &&
    value.api_spec_contents.every(isSpecContents)
  );
}

/**
 * Authority issued by Edge v0.9.12 or earlier (`admin-deployment-snapshot` v1): spec
 * bytes inline and no `api_spec_contents`. Recovery journals written before Edge
 * v0.9.13 still hold it, and Edge v0.9.13 refuses its token with `412`. It is
 * recognized only so that it is refused before any request is sent.
 */
export function isLegacyDeploymentSnapshot(value: unknown): boolean {
  return isSnapshotEnvelope(value) && !Object.hasOwn(value, 'api_spec_contents');
}

/** Never re-read authority for a legacy journal: that would be a fresh-token retry. */
export function legacyDeploymentAuthority(): NexusError {
  return conflict(
    'The recovery journal holds deployment authority issued by Ferrum Edge v0.9.12 or ' +
      'earlier, which Edge v0.9.13 refuses; retain the journal and resolve it by observation',
    { kind: 'legacy_deployment_authority' },
  );
}

/**
 * An acknowledgement that proves the mutation was never committed: `durable`
 * `not_started` (refused before the mutation transaction opened) or
 * `not_committed` (raised inside it, rolled back). Edge v0.9.14 also reports a
 * `503` store failure this way, and keeps `unknown` for a failed commit, a failed
 * commit acknowledgement or a lost settlement task. A definite non-commit still
 * authorizes neither cleanup nor replay: the caller keeps its journal.
 */
export function isDeploymentNonCommit(value: unknown): boolean {
  return (
    isDeploymentAcknowledgement(value) &&
    record(value) &&
    (value.durable === 'not_started' || value.durable === 'not_committed') &&
    value.live === 'unconfirmed' &&
    value.recovery_cleanup_authorized === false
  );
}

/**
 * A `507 Insufficient Storage` whose acknowledgement proves nothing was committed:
 * the namespace exceeds the owner's conditional snapshot bound. Deterministic for
 * unchanged state, so it is never retried. Any other `507` body stays uncertain.
 */
export function isSnapshotTooLargeRefusal(value: unknown): boolean {
  return isDeploymentNonCommit(value);
}

export function isDeploymentAcknowledgement(value: unknown): boolean {
  return (
    record(value) &&
    typeof value.durable === 'string' &&
    ['not_started', 'not_committed', 'committed', 'unknown'].includes(value.durable) &&
    typeof value.live === 'string' &&
    ['unconfirmed', 'not_applicable', 'applied'].includes(value.live) &&
    typeof value.recovery_cleanup_authorized === 'boolean' &&
    (value.profile === undefined || value.profile === 'deployment-v1') &&
    (value.id === undefined || typeof value.id === 'string') &&
    (value.error === undefined || typeof value.error === 'string') &&
    (!value.recovery_cleanup_authorized ||
      (value.durable === 'committed' && value.live === 'applied'))
  );
}

/** Called only after the transport has required HTTP 200. No remote-DP claim. */
export function assertDeploymentApplied(
  acknowledgement: EdgeDeploymentAcknowledgement,
  id: string,
): void {
  if (
    acknowledgement.profile !== 'deployment-v1' ||
    acknowledgement.id !== id ||
    acknowledgement.durable !== 'committed' ||
    acknowledgement.live !== 'applied' ||
    acknowledgement.recovery_cleanup_authorized !== true
  ) {
    throw edgeError('Gateway deployment application is unconfirmed; retain recovery state', {
      kind: 'deployment_acknowledgement_uncertain',
    });
  }
}

function ordered(rows: unknown[]): unknown[] {
  return [...rows].sort((left, right) => {
    const leftId = String(record(left) ? left.id : '');
    const rightId = String(record(right) ? right.id : '');
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
}

/** The owner sorts only the association ids in its typed comparison representation. */
export function deploymentProxyShape(proxy: EdgeProxy): EdgeProxy {
  return {
    ...proxy,
    plugins: [...proxy.plugins].sort((left, right) => {
      const leftId = left.plugin_config_id;
      const rightId = right.plugin_config_id;
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    }),
  };
}

/** Bind interpreted arrays to the owner's complete original comparison representation. */
export function assertDeploymentEvidence(
  snapshot: EdgeDeploymentSnapshot,
  namespace: string,
): void {
  if (isLegacyDeploymentSnapshot(snapshot)) throw legacyDeploymentAuthority();
  const resources = snapshot.evidence.resources;
  const stored = snapshot.evidence.stored;
  const sqlTables = [
    'proxies',
    'consumers',
    'upstreams',
    'plugin_configs',
    'proxy_plugins',
    'api_specs',
    'gateway_trust_bundles',
    'consumer_identity_index',
    'consumer_credential_index',
    'namespaces',
  ];
  // Mongo has embedded associations and credential indexes. Its stored rows
  // carry document/bson_sha256; SQL rows carry lossless typed column values,
  // with blobs as {sha256, len}.
  const mongoCollections = sqlTables.filter(
    (table) => table !== 'proxy_plugins' && table !== 'consumer_credential_index',
  );
  const sqlRows = (rows: unknown): boolean =>
    Array.isArray(rows) &&
    rows.every(
      (row) =>
        record(row) &&
        Object.keys(row).length > 0 &&
        Object.values(row).every(
          (column) =>
            record(column) &&
            typeof column.column_type === 'string' &&
            typeof column.value_type === 'string' &&
            Object.hasOwn(column, 'value'),
        ),
    );
  if (
    snapshot.namespace !== namespace ||
    snapshot.evidence.profile !== 'deployment-v1' ||
    !Array.isArray(resources) ||
    resources.length !== 8 ||
    !resources.slice(0, 6).every(Array.isArray) ||
    !(resources[6] === null || record(resources[6])) ||
    !Number.isSafeInteger(resources[7]) ||
    Number(resources[7]) < 0 ||
    !record(stored) ||
    !snapshot.proxies.every(
      (proxy) =>
        typeof proxy.id === 'string' &&
        Array.isArray(proxy.plugins) &&
        proxy.plugins.every(
          (association) => record(association) && typeof association.plugin_config_id === 'string',
        ),
    ) ||
    !mongoCollections.every((table) => Array.isArray(stored[table])) ||
    !(
      sqlTables.every((table) => sqlRows(stored[table])) ||
      Object.values(stored).every(
        (rows) =>
          Array.isArray(rows) &&
          rows.every(
            (row) =>
              record(row) &&
              record(row.document) &&
              typeof row.bson_sha256 === 'string' &&
              SHA256_HEX.test(row.bson_sha256),
          ),
      )
    ) ||
    !isDeepStrictEqual(ordered(snapshot.proxies.map(deploymentProxyShape)), resources[0]) ||
    !isDeepStrictEqual(ordered(snapshot.upstreams), resources[2]) ||
    !isDeepStrictEqual(ordered(snapshot.plugin_configs), resources[3]) ||
    // The owner sorts api_specs by id in byte order; it equals resources[5].
    !isDeepStrictEqual(snapshot.api_specs, resources[5]) ||
    !contentsVerified(snapshot)
  ) {
    throw edgeError('The gateway deployment snapshot cannot establish original authority');
  }
}

/** Strict standard padded base64 whose bytes match the digest the token fences. */
function decodedContent(encoded: unknown, digest: unknown): Buffer | null {
  if (typeof encoded !== 'string' || !isStoredDigest(digest)) return null;
  const bytes = Buffer.from(encoded, 'base64');
  if (
    bytes.toString('base64') !== encoded ||
    bytes.length !== digest.len ||
    createHash('sha256').update(bytes).digest('hex') !== digest.sha256
  ) {
    return null;
  }
  return bytes;
}

/**
 * `api_spec_contents` lies outside the digested evidence: each entry must name its
 * spec in `api_specs` order and decode to the stored bytes the evidence fences.
 */
function contentsVerified(snapshot: EdgeDeploymentSnapshot): boolean {
  const contents: unknown = snapshot.api_spec_contents;
  if (!Array.isArray(contents) || contents.length !== snapshot.api_specs.length) return false;
  const seen = new Set<string>();
  return snapshot.api_specs.every((spec, index) => {
    const entry: unknown = contents[index];
    const id = spec.id;
    if (!isSpecContents(entry) || typeof id !== 'string' || entry.id !== id || seen.has(id)) {
      return false;
    }
    seen.add(id);
    const external = spec.external_ref_snapshot ?? null;
    return (
      decodedContent(entry.spec_content_base64, spec.spec_content) !== null &&
      (external === null) === (entry.external_ref_snapshot_base64 === null) &&
      (external === null || decodedContent(entry.external_ref_snapshot_base64, external) !== null)
    );
  });
}

/**
 * Decode only the bounded target document. Its stored gzip bytes come from
 * `api_spec_contents`, verified against the digest the token fences; the journal
 * keeps them as captured.
 */
export function deploymentSpecDocument(
  snapshot: EdgeDeploymentSnapshot,
  spec: Record<string, unknown>,
): Record<string, unknown> {
  if (isLegacyDeploymentSnapshot(snapshot)) throw legacyDeploymentAuthority();
  try {
    const entries = Array.isArray(snapshot.api_spec_contents)
      ? snapshot.api_spec_contents.filter((entry) => isSpecContents(entry) && entry.id === spec.id)
      : [];
    const entry = entries.length === 1 ? entries[0] : undefined;
    const compressed = entry ? decodedContent(entry.spec_content_base64, spec.spec_content) : null;
    if (
      !compressed ||
      spec.content_encoding !== 'gzip' ||
      !['json', 'yaml'].includes(String(spec.spec_format))
    ) {
      throw new Error('Invalid stored spec');
    }
    const bytes = gunzipSync(compressed, { maxOutputLength: 2 * 1024 * 1024 });
    if (
      bytes.length !== spec.uncompressed_size ||
      createHash('sha256').update(bytes).digest('hex') !== spec.content_hash
    ) {
      throw new Error('Invalid stored spec digest');
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const yaml = spec.spec_format === 'yaml' ? parseDocument(text, { uniqueKeys: true }) : null;
    if (yaml && yaml.errors.length > 0) throw new Error('Invalid stored YAML');
    const document: unknown = yaml ? yaml.toJS({ maxAliasCount: 100 }) : JSON.parse(text);
    if (!record(document)) throw new Error('Invalid stored document');
    return document;
  } catch {
    throw edgeError('The original gateway specification cannot be verified');
  }
}

export function deploymentTarget(
  snapshot: EdgeDeploymentSnapshot,
  id: string,
): { proxy: EdgeProxy; plugins: EdgePluginConfig[]; spec: Record<string, unknown> | null } {
  const proxies = snapshot.proxies.filter((proxy) => proxy.id === id);
  const specs = snapshot.api_specs.filter((spec) => spec.proxy_id === id);
  const proxy = proxies[0];
  if (
    proxies.length !== 1 ||
    !proxy ||
    specs.length > 1 ||
    (specs[0]?.id ?? null) !== (proxy.api_spec_id ?? null) ||
    proxy.namespace !== snapshot.namespace ||
    !Array.isArray(proxy.plugins) ||
    proxy.plugins.some((association) =>
      Object.keys(association).some((field) => field !== 'plugin_config_id'),
    )
  ) {
    throw conflict('The original deployment ownership is inconsistent');
  }
  const plugins = snapshot.plugin_configs.filter((plugin) => plugin.proxy_id === id);
  if (
    plugins.some(
      (plugin) =>
        plugin.namespace !== snapshot.namespace ||
        plugin.scope !== 'proxy' ||
        (plugin.api_spec_id != null && plugin.api_spec_id !== proxy.api_spec_id),
    ) ||
    proxy.plugins.some(
      (association) => !plugins.some((plugin) => plugin.id === association.plugin_config_id),
    )
  ) {
    // Nexus cannot replay shared proxy_group owners. Refuse before removal.
    throw conflict('The deployment has unrepresentable plugin ownership or associations');
  }
  return { proxy, plugins, spec: specs[0] ?? null };
}
