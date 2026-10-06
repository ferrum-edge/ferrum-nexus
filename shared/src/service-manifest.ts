export const MANIFEST_BODY_LIMIT = 32 * 1024;

/** EXISTING shared v1 contract intake; JSON data only, never a file or URL. */
export interface PreviewServiceManifestRequest {
  namespace: string;
  manifest: unknown;
}

/** Bounded allow-listed summary. Source paths, locations and free text are redacted. */
export interface PreviewServiceManifestResponse {
  preview_only: true;
  contract_status: 'implemented';
  contract_commit: string;
  namespace: string;
  service: string;
  public_path: string;
  protocols: string[];
  auth_mode: string;
  agents: { enabled: boolean; endpoint_path: string; namespace: string } | null;
  references: {
    openapi_declared: boolean;
    telemetry_declared: boolean;
    tls_client_declared: boolean;
    tls_ca_declared: boolean;
    values: '[REDACTED]';
  };
}
