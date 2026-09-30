import { MAX_UPSTREAM_URL_LENGTH } from './constants.js';
import type { SpecChange, SpecChangeReport } from './entities.js';

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

/**
 * A change report that lists nothing. `complete` is `false` for one standing
 * in for a comparison that could not be made at all, such as a previous
 * revision whose stored document no longer parses.
 */
export function emptySpecChangeReport(complete = true): SpecChangeReport {
  return {
    changed: false,
    complete,
    changes: [],
    counts: {
      breaking: 0,
      non_breaking: 0,
      operations_added: 0,
      operations_removed: 0,
      operations_deprecated: 0,
      operations_changed: 0,
    },
    truncated: false,
    info_changes: [],
  };
}

/** What a change is in, for a sentence: `Parameter query limit`, `Response 200`. */
function specChangeSubject(change: SpecChange): string {
  const at = change.location ?? '';
  if (change.operation === null) {
    return `Schema ${at} (in ${change.section === 'response' ? 'responses' : 'requests'})`;
  }
  switch (change.section) {
    case 'parameter':
      return `Parameter ${at}`;
    case 'request':
      return at === '' ? 'Request body' : `Request body ${at}`;
    case 'response':
      return `Response ${at}`;
    default:
      return 'Operation';
  }
}

/**
 * One {@link SpecChange} as a sentence, for the catalog's change history and
 * the notifications that link to it. Plain text: every caller renders it as
 * text, never as markup, because it quotes provider-written names.
 */
export function describeSpecChange(change: SpecChange): string {
  const subject = specChangeSubject(change);
  const field = change.schema_path ? `${subject}, field ${change.schema_path}` : subject;
  const detail = change.to ? ` (${change.to})` : '';
  switch (change.kind) {
    case 'operation_added':
      return 'Operation added';
    case 'operation_removed':
      return 'Operation removed: requests to it may now fail';
    case 'operation_deprecated':
      return 'Operation deprecated';
    case 'operation_undeprecated':
      return 'Operation no longer deprecated';
    case 'parameter_added':
      return `${subject} added${detail}`;
    case 'parameter_removed':
      return `${subject} removed`;
    case 'parameter_required':
      return `${subject} is now required`;
    case 'parameter_optional':
      return `${subject} is now optional`;
    case 'request_body_added':
      return 'Request body added';
    case 'request_body_removed':
      return 'Request body removed';
    case 'request_body_required':
      return 'Request body is now required';
    case 'request_body_optional':
      return 'Request body is now optional';
    case 'response_added':
      return `${subject} added`;
    case 'response_removed':
      return `${subject} removed`;
    case 'media_type_added':
      return `${subject}: media type added`;
    case 'media_type_removed':
      return `${subject}: media type removed`;
    case 'schema_type_changed':
      return `${field}: type changed from ${change.from ?? 'any'} to ${change.to ?? 'any'}`;
    case 'schema_property_added':
      return `${field}: added${detail}`;
    case 'schema_property_removed':
      return `${field}: removed`;
    case 'schema_property_required':
      return `${field}: now required`;
    case 'schema_property_optional':
      return `${field}: now optional`;
    case 'schema_enum_values_added':
      return change.from === 'any value'
        ? `${field}: now restricted to ${change.to ?? 'fixed values'}`
        : `${field}: now also allows ${change.to ?? 'more values'}`;
    case 'schema_enum_values_removed':
      return change.to === 'any value'
        ? `${field}: no longer restricted to fixed values`
        : `${field}: no longer allows ${change.from ?? 'some values'}`;
    case 'schema_composition_changed':
      return `${field}: changed from ${change.from ?? '?'} to ${change.to ?? '?'}`;
  }
}
