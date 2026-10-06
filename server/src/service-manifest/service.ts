import {
  roleAtLeast,
  MANIFEST_BODY_LIMIT,
  type PreviewServiceManifestRequest,
  type PreviewServiceManifestResponse,
} from '@ferrum-nexus/shared';
import type { UserRecord } from '../db/store.js';
import { forbidden, validationFailed } from '../lib/errors.js';
import { manifestDefaults, manifestSchema, manifestValidator } from './schema.js';

const CONTRACT_COMMIT = '31f0a21d707795be293d15837c2f77c3d84219d8';

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
    !/[{}*~ ?#;%\\]/.test(value) &&
    !value.includes('//') &&
    !value.split('/').some((part) => part === '.' || part === '..')
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
    if (typeof value === 'string' && (value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value))) {
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
  const id = gateway.proxy_id ?? manifest.service.name;
  if (
    (health && id.length + 9 > 254) ||
    (gateway.correlation_id && id.length + 15 > 254) ||
    (gateway.otel_endpoint && id.length + 13 > 254)
  ) {
    throw validationFailed('Manifest resource reference exceeds the limit');
  }
  if (agents?.endpoint_path) {
    const prefix = `${api.public_path.replace(/\/+$/, '')}/`;
    if (
      !literalPath(agents.endpoint_path) ||
      !agents.endpoint_path.startsWith(prefix) ||
      agents.endpoint_path.length === prefix.length
    ) {
      throw validationFailed('Manifest MCP endpoint must be below the public path');
    }
  }
  if (gateway.otel_endpoint) {
    try {
      const endpoint = new URL(gateway.otel_endpoint);
      if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
        throw new Error();
      }
    } catch {
      throw validationFailed('Manifest telemetry reference must be credential-free');
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
              endpoint_path: agents.endpoint_path ?? `${api.public_path.replace(/\/+$/, '')}/mcp`,
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
