/**
 * Listen port and `/api` proxy target for the Vite dev server.
 *
 * Production serves the built SPA from the BFF, so these knobs exist only for
 * `npm run dev`. `NEXUS_PORT` is the existing API bind port (see
 * `server/src/config`); the SPA proxies `/api` to that port unless
 * `NEXUS_API_PROXY_TARGET` names a different origin.
 */

/** Default Vite listen port (`NEXUS_WEB_PORT` / `VITE_DEV_PORT`). */
export const DEFAULT_WEB_PORT = 5173;

/** Default API bind port (`NEXUS_PORT`), matching `server/src/config`. */
export const DEFAULT_API_PORT = 8787;

/** Default `/api` proxy origin when `NEXUS_PORT` / `NEXUS_HOST` are unset. */
export const DEFAULT_API_PROXY_TARGET = 'http://127.0.0.1:8787';

/** Resolved Vite `server.port` and `/api` proxy `target`. */
export interface DevServerPorts {
  webPort: number;
  apiProxyTarget: string;
}

const PORT_MIN = 1;
const PORT_MAX = 65_535;

const PROXY_TARGET_RULE =
  'NEXUS_API_PROXY_TARGET must be an absolute http(s) URL with no path, ' +
  'query, credentials, or fragment';

/** Bind addresses that are not a connectable proxy host. */
const WILDCARD_BIND_HOSTS = new Set(['0.0.0.0', '::', '::0', '*']);

function firstPresent(
  env: Record<string, string | undefined>,
  names: readonly string[],
): { name: string; value: string } | undefined {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.trim() !== '') {
      return { name, value };
    }
  }
  return undefined;
}

function parsePort(name: string, raw: string, defaultValue: number): number {
  const trimmed = raw.trim();
  if (trimmed === '') return defaultValue;
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < PORT_MIN || value > PORT_MAX) {
    throw new Error(
      `${name} must be an integer between ${PORT_MIN} and ${PORT_MAX} ` +
        `(got ${JSON.stringify(raw)})`,
    );
  }
  return value;
}

function stripWrappingBrackets(host: string): string {
  return host.replace(/^\[|\]$/g, '');
}

/**
 * Host the browser (via Vite's proxy) should connect to.
 *
 * `NEXUS_HOST` is a bind address. `0.0.0.0` / `::` mean "all interfaces" and
 * are not a usable proxy target, so they become loopback.
 */
export function proxyHostFromBind(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return '127.0.0.1';
  const host = stripWrappingBrackets(trimmed);
  if (WILDCARD_BIND_HOSTS.has(host.toLowerCase())) return '127.0.0.1';
  return host;
}

function formatHttpOrigin(host: string, port: number): string {
  const hostPart = host.includes(':') ? `[${stripWrappingBrackets(host)}]` : host;
  return `http://${hostPart}:${port}`;
}

/**
 * Require an absolute http(s) origin: scheme + host + optional port, nothing else.
 */
export function parseApiProxyTarget(raw: string): string {
  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${PROXY_TARGET_RULE} (got ${JSON.stringify(raw)})`);
  }

  const invalid =
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    (parsed.pathname !== '' && parsed.pathname !== '/');

  if (invalid || parsed.host === '') {
    throw new Error(`${PROXY_TARGET_RULE} (got ${JSON.stringify(raw)})`);
  }

  return `${parsed.protocol}//${parsed.host}`;
}

/**
 * Resolve the Vite listen port and `/api` proxy target from an env record.
 *
 * Precedence:
 * - Web port: `NEXUS_WEB_PORT`, then `VITE_DEV_PORT`, then {@link DEFAULT_WEB_PORT}.
 * - Proxy: `NEXUS_API_PROXY_TARGET` if set, otherwise `http://<host>:<NEXUS_PORT>`
 *   where `<host>` is {@link proxyHostFromBind}(`NEXUS_HOST`).
 */
export function resolveDevServerPorts(
  env: Record<string, string | undefined> = {},
): DevServerPorts {
  const web = firstPresent(env, ['NEXUS_WEB_PORT', 'VITE_DEV_PORT']);
  const webPort = web
    ? parsePort(web.name, web.value, DEFAULT_WEB_PORT)
    : DEFAULT_WEB_PORT;

  const proxy = firstPresent(env, ['NEXUS_API_PROXY_TARGET']);
  if (proxy) {
    return { webPort, apiProxyTarget: parseApiProxyTarget(proxy.value) };
  }

  const apiPortRaw = env.NEXUS_PORT;
  const apiPort =
    apiPortRaw === undefined || apiPortRaw.trim() === ''
      ? DEFAULT_API_PORT
      : parsePort('NEXUS_PORT', apiPortRaw, DEFAULT_API_PORT);

  return {
    webPort,
    apiProxyTarget: formatHttpOrigin(proxyHostFromBind(env.NEXUS_HOST), apiPort),
  };
}
