/** Released Edge v0.9.12 deployment authority; never derive or refresh its keyed token. */
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { isDeepStrictEqual } from 'node:util';
import { parseDocument } from 'yaml';

import { conflict, edgeError } from '../lib/errors.js';
import type {
  EdgeDeploymentAcknowledgement,
  EdgeDeploymentSnapshot,
  EdgePluginConfig,
  EdgeProxy,
} from './types.js';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isDeploymentTag(value: unknown): value is string {
  return typeof value === 'string' && /^"deployment-v1-[0-9a-f]{32}"(?![\s\S])/.test(value);
}

/** Envelope validation is not a certificate of complete raw SQL/BSON evidence. */
export function isDeploymentSnapshot(value: unknown): value is EdgeDeploymentSnapshot {
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
  // carry document/bson_hex; SQL rows carry lossless typed column values.
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
            (row) => record(row) && record(row.document) && typeof row.bson_hex === 'string',
          ),
      )
    ) ||
    !isDeepStrictEqual(ordered(snapshot.proxies.map(deploymentProxyShape)), resources[0]) ||
    !isDeepStrictEqual(ordered(snapshot.upstreams), resources[2]) ||
    !isDeepStrictEqual(ordered(snapshot.plugin_configs), resources[3]) ||
    !isDeepStrictEqual(ordered(snapshot.api_specs), resources[5])
  ) {
    throw edgeError('The gateway deployment snapshot cannot establish original authority');
  }
}

/** Decode only the bounded target document; keep gzip/external-reference bytes in the journal. */
export function deploymentSpecDocument(spec: Record<string, unknown>): Record<string, unknown> {
  try {
    if (
      spec.content_encoding !== 'gzip' ||
      !Array.isArray(spec.spec_content) ||
      !spec.spec_content.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255) ||
      !['json', 'yaml'].includes(String(spec.spec_format))
    ) {
      throw new Error('Invalid stored spec');
    }
    const bytes = gunzipSync(Buffer.from(spec.spec_content), { maxOutputLength: 2 * 1024 * 1024 });
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
