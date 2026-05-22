import type { ApiAssetWithProvider } from '@ferrum-nexus/shared';

export function ApiKeyFactsPanel({ asset }: { asset: ApiAssetWithProvider }) {
  const facts = [
    ['Proxy endpoints', asset.proxyHosts.length || asset.proxyPaths.length ? endpoints(asset) : null],
    ['Upstream', asset.proxyUpstreamUrl],
    ['Timeouts', timeoutText(asset)],
    ['Body limit', asset.bodySizeLimitBytes ? `${formatBytes(asset.bodySizeLimitBytes)}` : null],
    ['Rate limit', asset.rateLimitPerMinute ? `${asset.rateLimitPerMinute}/min` : null],
    ['Source', asset.sourceFormat === 'swagger2' ? 'Swagger 2.0 converted' : 'OpenAPI 3.x'],
    ['Contact', contactText(asset)],
    ['Support', asset.supportNotes],
  ] as const;

  return (
    <div className="card">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {facts.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <div className="muted text-xs">{label}</div>
            <div className="truncate text-sm font-medium">{value || <span className="muted">Not specified</span>}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function contactText(asset: ApiAssetWithProvider): string | null {
  const parts = [asset.contactName, asset.contactEmail, asset.contactUrl].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

function endpoints(asset: ApiAssetWithProvider): string {
  if (asset.proxyHosts.length === 0) return asset.proxyPaths.join(', ');
  if (asset.proxyPaths.length === 0) return asset.proxyHosts.join(', ');
  return asset.proxyHosts.flatMap((host) => asset.proxyPaths.map((path) => `${host}${path}`)).join(', ');
}

function timeoutText(asset: ApiAssetWithProvider): string | null {
  const parts = [
    asset.timeoutConnectMs ? `connect ${asset.timeoutConnectMs}ms` : null,
    asset.timeoutReadMs ? `read ${asset.timeoutReadMs}ms` : null,
    asset.timeoutWriteMs ? `write ${asset.timeoutWriteMs}ms` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}
