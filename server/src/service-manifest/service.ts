import {
  roleAtLeast,
  MANIFEST_BODY_LIMIT,
  type PreviewServiceManifestRequest,
  type PreviewServiceManifestResponse,
} from '@ferrum-nexus/shared';
import type { UserRecord } from '../db/store.js';
import { forbidden, validationFailed } from '../lib/errors.js';
import {
  characterLength,
  longestManifestString,
  manifestDefaults,
  manifestSchema,
  manifestValidator,
} from './schema.js';

const RESERVED_PATH_CHARACTER = /[{}*~ ?#;%\\]/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const TRAILING_SLASHES = /\/+$/;
const CLEARTEXT_SCHEME = /^http:\/\//i;
const AUTHORITY_END = /[/?#]/;
const LOOPBACK_AUTHORITY = /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])(?::\d*)?$/;
const LOOPBACK_IPV4_HOST = /^127\.\d+\.\d+\.\d+$/;

/** Edge's resource ID limit and the suffixes Alloy appends to the proxy ID. */
const EDGE_RESOURCE_ID_MAX_LENGTH = 254;
const UPSTREAM_ID_SUFFIX = '-upstream';
const CORRELATION_ID_PLUGIN_ID_SUFFIX = '-correlation-id';
const OTEL_TRACING_PLUGIN_ID_SUFFIX = '-otel-tracing';

const CONTRACT_COMMIT = '39da322083044c2e92617209e62983c92387f0ad';

interface Manifest {
  service: { name: string };
  api: { public_path: string; service_base_path: string; openapi?: string };
  upstream: {
    protocols: string[];
    gateway_client_cert_path?: string;
    gateway_client_key_path?: string;
    server_ca_path?: string;
  };
  health?: { path: string };
  gateway: {
    namespace: string;
    proxy_id?: string;
    otel_endpoint?: string;
    correlation_id: boolean;
  };
  auth: { mode?: string };
  agents?: { enabled: boolean; endpoint_path?: string; namespace?: string };
}

function literalPath(value: string): boolean {
  return (
    value.startsWith('/') &&
    !RESERVED_PATH_CHARACTER.test(value) &&
    !value.includes('//') &&
    !value.split('/').some((part) => part === '.' || part === '..')
  );
}

/**
 * Whether a cleartext endpoint names a canonical loopback IP literal: a
 * dotted-quad `127.d.d.d` or `[::1]`, optionally with a numeric port, as
 * written. Ferrum Edge v0.9.19 and later drop an `http://` exporter to any
 * other host unless `allow_plaintext` is set, which Alloy's export never
 * writes (Edge `is_loopback_ip_literal_endpoint`). `localhost`, `127.1` and
 * `[0:0:0:0:0:0:0:1]` do not qualify.
 */
function loopbackLiteral(endpoint: string, url: URL): boolean {
  const rest = endpoint.replace(CLEARTEXT_SCHEME, '');
  const end = rest.search(AUTHORITY_END);
  const authority = end === -1 ? rest : rest.slice(0, end);
  return (
    LOOPBACK_AUTHORITY.test(authority) &&
    (url.hostname === '[::1]' || LOOPBACK_IPV4_HOST.test(url.hostname))
  );
}

/** Bound the tree before recursive validation; do not echo offending data. */
export function validatedManifest(body: unknown): Manifest {
  const pending = [{ value: body, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const entry = pending.pop();
    if (!entry || ++count > 1024 || entry.depth > 8) {
      throw validationFailed('Manifest budget exceeded');
    }
    const { value, depth } = entry;
    if (
      typeof value === 'string' &&
      (characterLength(value) > longestManifestString || CONTROL_CHARACTER.test(value))
    ) {
      throw validationFailed('Manifest presentation string is invalid');
    }
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) pending.push({ value: child, depth: depth + 1 });
    }
  }
  if (Buffer.byteLength(JSON.stringify(body) ?? '') > MANIFEST_BODY_LIMIT) {
    throw validationFailed('Manifest budget exceeded');
  }
  const result = manifestValidator.safeParse(body);
  if (!result.success) throw validationFailed('Invalid service-manifest v1');
  const value = result.data as Record<string, unknown>;
  const manifest = manifestDefaults(manifestSchema, {
    ...value,
    gateway: value.gateway ?? {},
    timeouts: value.timeouts ?? {},
    auth: value.auth ?? {},
  }) as Manifest;
  const { api, gateway, health, agents } = manifest;
  if (
    !literalPath(api.public_path) ||
    !literalPath(api.service_base_path) ||
    (health && !literalPath(health.path))
  ) {
    throw validationFailed('Manifest requires canonical literal paths');
  }
  // The resource IDs Alloy derives from the proxy ID (qualified against
  // ferrum-alloy main 2b206a46, `ServiceManifest::validate`). The tracing
  // plugin is generated for every export, with or without an exporter, since
  // it neutralizes caller trace context.
  const id = gateway.proxy_id ?? manifest.service.name;
  const derived = [
    ...(health ? [UPSTREAM_ID_SUFFIX] : []),
    ...(gateway.correlation_id ? [CORRELATION_ID_PLUGIN_ID_SUFFIX] : []),
    OTEL_TRACING_PLUGIN_ID_SUFFIX,
  ];
  if (derived.some((suffix) => id.length + suffix.length > EDGE_RESOURCE_ID_MAX_LENGTH)) {
    throw validationFailed('Manifest resource reference exceeds the limit');
  }
  if (agents?.endpoint_path) {
    const prefix = `${api.public_path.replace(TRAILING_SLASHES, '')}/`;
    if (
      !literalPath(agents.endpoint_path) ||
      !agents.endpoint_path.startsWith(prefix) ||
      agents.endpoint_path.length === prefix.length
    ) {
      throw validationFailed('Manifest MCP endpoint must be below the public path');
    }
  }
  if (gateway.otel_endpoint) {
    let endpoint: URL;
    try {
      endpoint = new URL(gateway.otel_endpoint);
      if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
        throw new Error();
      }
    } catch {
      throw validationFailed('Manifest telemetry reference must be credential-free');
    }
    // Edge trims the configured endpoint before it checks it.
    const written = gateway.otel_endpoint.trim();
    if (endpoint.protocol === 'http:' && !loopbackLiteral(written, new URL(written))) {
      throw validationFailed(
        'Manifest telemetry reference must use https unless its host is a loopback IP literal',
      );
    }
  }
  return manifest;
}

export interface ServiceManifestService {
  preview(actor: UserRecord, input: PreviewServiceManifestRequest): PreviewServiceManifestResponse;
}

/** No store, gateway client, HTTP client or TLS reader is a dependency. */
export function createServiceManifestService(namespace: string): ServiceManifestService {
  return {
    preview(actor, input): PreviewServiceManifestResponse {
      if (!roleAtLeast(actor.role, 'provider') || input.namespace !== namespace) throw forbidden();
      const manifest = validatedManifest(input.manifest);
      if (manifest.gateway.namespace !== namespace) throw forbidden();
      const { api, service, upstream, gateway, agents, auth } = manifest;
      return {
        preview_only: true,
        contract_status: 'implemented',
        contract_commit: CONTRACT_COMMIT,
        namespace,
        service: service.name,
        public_path: api.public_path,
        protocols: upstream.protocols,
        auth_mode: auth.mode ?? 'unspecified',
        agents: agents
          ? {
              enabled: agents.enabled,
              endpoint_path:
                agents.endpoint_path ?? `${api.public_path.replace(TRAILING_SLASHES, '')}/mcp`,
              namespace: agents.namespace ?? service.name,
            }
          : null,
        references: {
          openapi_declared: api.openapi !== undefined,
          telemetry_declared: gateway.otel_endpoint !== undefined,
          tls_client_declared: upstream.gateway_client_cert_path !== undefined,
          tls_ca_declared: upstream.server_ca_path !== undefined,
          values: '[REDACTED]',
        },
      };
    },
  };
}
