import { MAX_UPSTREAM_URL_LENGTH } from './constants.js';

/** Maximum length of the slug used in an API's listen path. */
export const MAX_API_SLUG_LENGTH = 60;

/** Characters accepted for a provider-supplied API slug. */
export const API_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidApiSlug(slug: string): boolean {
  return slug.length <= MAX_API_SLUG_LENGTH && API_SLUG_PATTERN.test(slug);
}

/** Turn a name into the same bounded, URL-safe slug in browser and server. */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_API_SLUG_LENGTH)
    .replace(/-+$/g, '');
}

/** Parse a usable upstream without applying the server's destination policy. */
export function parseAbsoluteHttpUrl(raw: string): URL | null {
  const trimmed = raw.trim();
  if (trimmed === '' || /[{}]/.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.hostname === '' || url.username !== '' || url.password !== '') return null;
  if (/[{}]/.test(url.hostname)) return null;
  if (url.port !== '' && (Number(url.port) < 1 || Number(url.port) > 65_535)) return null;
  return url;
}

export interface ExpandedServerUrl {
  url: string | null;
  tooLong: boolean;
}

/** Substitute declared string defaults, keeping unresolved templates unusable. */
export function expandServerUrl(server: Record<string, unknown>): ExpandedServerUrl {
  if (typeof server.url !== 'string') return { url: null, tooLong: false };
  const variables = isRecord(server.variables) ? server.variables : {};
  const template = server.url.trim();
  const parts: string[] = [];
  let offset = 0;
  let expandedLength = 0;
  const append = (part: string): boolean => {
    expandedLength += part.length;
    if (expandedLength > MAX_UPSTREAM_URL_LENGTH) return false;
    parts.push(part);
    return true;
  };
  for (const match of template.matchAll(/\{([^{}]+)\}/g)) {
    const name = match[1] as string;
    if (!append(template.slice(offset, match.index))) return { url: null, tooLong: true };
    const variable = Object.hasOwn(variables, name) ? variables[name] : undefined;
    if (
      !isRecord(variable) ||
      typeof variable.default !== 'string' ||
      (variable.enum !== undefined &&
        (!Array.isArray(variable.enum) || !variable.enum.includes(variable.default)))
    ) {
      return { url: null, tooLong: false };
    }
    if (!append(variable.default)) return { url: null, tooLong: true };
    offset = match.index + match[0].length;
  }
  if (!append(template.slice(offset))) return { url: null, tooLong: true };
  const expanded = parts.join('');
  return { url: /[{}]/.test(expanded) ? null : expanded, tooLong: false };
}

export interface SpecServerUrlResult {
  url: string | null;
  oversizedField: string | null;
}

/** Select the first usable root server URL, as the publish service does. */
export function firstUsableSpecServerUrl(servers: unknown): SpecServerUrlResult {
  if (!Array.isArray(servers)) return { url: null, oversizedField: null };
  for (const [index, server] of servers.entries()) {
    if (!isRecord(server) || typeof server.url !== 'string') continue;
    const expanded = expandServerUrl(server);
    if (expanded.tooLong) return { url: null, oversizedField: `servers[${index}].url` };
    if (expanded.url !== null && parseAbsoluteHttpUrl(expanded.url)) {
      return { url: expanded.url, oversizedField: null };
    }
  }
  return { url: null, oversizedField: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
