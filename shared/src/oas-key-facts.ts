export interface KeyFacts {
  proxyHosts: string[];
  proxyPaths: string[];
  proxyEndpoints: string[];
  upstreamUrl: string | null;
  timeoutConnectMs: number | null;
  timeoutReadMs: number | null;
  timeoutWriteMs: number | null;
  bodySizeLimitBytes: number | null;
  rateLimitPerMinute: number | null;
  operationPaths: string[];
  operationSummaries: string[];
  sourceFormat: 'openapi3' | 'swagger2';
}

type Obj = Record<string, unknown>;

const HTTP_METHODS = new Set([
  'get',
  'put',
  'post',
  'delete',
  'patch',
  'options',
  'head',
  'trace',
]);

export function extractKeyFacts(spec: unknown): KeyFacts {
  const parsed = typeof spec === 'string' ? parseJsonObject(spec) : asObject(spec);
  const proxy = asObject(parsed?.['x-ferrum-proxy']);
  const proxyHosts = stringArray(proxy?.hosts);
  const proxyPaths = stringArray(proxy?.paths);
  const timeouts = asObject(proxy?.timeouts);
  const operationPaths = parsed ? Object.keys(asObject(parsed.paths) ?? {}) : [];
  const operationSummaries = parsed ? extractOperationSummaries(parsed.paths) : [];
  const sourceFormat = typeof parsed?.swagger === 'string' && parsed.swagger.startsWith('2.')
    ? 'swagger2'
    : 'openapi3';

  return {
    proxyHosts,
    proxyPaths,
    proxyEndpoints: buildProxyEndpoints(proxyHosts, proxyPaths),
    upstreamUrl: typeof proxy?.upstream_url === 'string' ? proxy.upstream_url : null,
    timeoutConnectMs: numberValue(timeouts?.connect_ms ?? timeouts?.connect),
    timeoutReadMs: numberValue(timeouts?.read_ms ?? timeouts?.read),
    timeoutWriteMs: numberValue(timeouts?.write_ms ?? timeouts?.write),
    bodySizeLimitBytes: numberValue(proxy?.body_size_limit_bytes ?? proxy?.body_size_limit),
    rateLimitPerMinute: extractRateLimit(proxy),
    operationPaths,
    operationSummaries,
    sourceFormat,
  };
}

function parseJsonObject(raw: string): Obj | null {
  try {
    return asObject(JSON.parse(raw));
  } catch {
    return null;
  }
}

function asObject(value: unknown): Obj | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function buildProxyEndpoints(hosts: string[], paths: string[]): string[] {
  if (hosts.length === 0) return paths;
  if (paths.length === 0) return hosts;
  const endpoints: string[] = [];
  for (const host of hosts) {
    for (const path of paths) {
      endpoints.push(`${host}${path.startsWith('/') ? path : `/${path}`}`);
    }
  }
  return endpoints;
}

function extractOperationSummaries(paths: unknown): string[] {
  const pathObj = asObject(paths);
  if (!pathObj) return [];
  const summaries: string[] = [];
  for (const item of Object.values(pathObj)) {
    const pathItem = asObject(item);
    if (!pathItem) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      const op = asObject(operation);
      const summary = op?.summary;
      if (typeof summary === 'string' && summary.trim()) summaries.push(summary);
    }
  }
  return summaries;
}

function extractRateLimit(proxy: Obj | null): number | null {
  const plugins = Array.isArray(proxy?.plugins) ? proxy.plugins : [];
  const plugin = plugins
    .map(asObject)
    .find((item) => item?.name === 'rate_limiting' || item?.name === 'rate-limiting');
  const config = asObject(plugin?.config);
  return (
    numberValue(config?.per_minute) ??
    numberValue(config?.requests_per_minute) ??
    numberValue(config?.minute) ??
    numberValue(config?.limit)
  );
}
