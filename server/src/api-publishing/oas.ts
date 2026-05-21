/**
 * OpenAPI parsing & validation helpers.
 *
 * We don't reimplement the OAS schema here — we just need enough to know:
 *  1. Whether the document parses as JSON or YAML.
 *  2. Whether it appears to be OAS 3.0 or 3.1 (presence of `openapi: 3.*`).
 *  3. Whether the required `x-ferrum-proxy` extension is present.
 *  4. The catalog metadata (title, version, tags, contact, operation count).
 */

import { parse as parseYaml } from 'yaml';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { badRequest } from '../lib/errors.js';

// Minimum required shape of the `x-ferrum-proxy` extension. We don't try to
// validate every Ferrum-specific field here — Edge owns full validation — but
// we do reject specs whose proxy descriptor is missing the bits Nexus needs
// to know about (the proxy id and at least one route target).
const FerrumProxySchema = z.object({
  proxy_id: z.string().min(1),
  paths: z.array(z.string()).optional(),
  hosts: z.array(z.string()).optional(),
  upstream_url: z.string().url().optional(),
});

export interface OasMetadata {
  title: string;
  version: string;
  description: string | null;
  tags: string[];
  contact: { name?: string; email?: string; url?: string } | null;
  servers: { url: string }[];
  operationCount: number;
  contentHash: string;
  rawContentType: 'application/json' | 'application/yaml';
}

export function detectContentType(raw: string): 'application/json' | 'application/yaml' {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'application/json';
  return 'application/yaml';
}

export function parseSpec(raw: string): Record<string, unknown> {
  const contentType = detectContentType(raw);
  try {
    return contentType === 'application/json'
      ? (JSON.parse(raw) as Record<string, unknown>)
      : (parseYaml(raw) as Record<string, unknown>);
  } catch (err) {
    throw badRequest(
      'invalid_spec',
      `Failed to parse OpenAPI document as ${contentType}`,
      err instanceof Error ? err.message : err,
    );
  }
}

export function extractMetadata(raw: string): OasMetadata {
  const contentType = detectContentType(raw);
  const parsed = parseSpec(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw badRequest('invalid_spec', 'OpenAPI document must be an object');
  }
  const openapi = parsed.openapi;
  if (typeof openapi !== 'string' || !openapi.startsWith('3.')) {
    throw badRequest('unsupported_oas_version', 'Only OpenAPI 3.x is supported');
  }
  const info = (parsed.info ?? {}) as Record<string, unknown>;
  const title = typeof info.title === 'string' ? info.title : 'Untitled API';
  const version = typeof info.version === 'string' ? info.version : '0.0.0';
  const description = typeof info.description === 'string' ? info.description : null;
  const tags = Array.isArray(parsed.tags)
    ? (parsed.tags as Array<{ name?: string }>)
        .map((t) => t.name)
        .filter((v): v is string => typeof v === 'string')
    : [];
  const contact = (info.contact as OasMetadata['contact']) ?? null;
  const servers = Array.isArray(parsed.servers)
    ? (parsed.servers as Array<{ url?: string }>)
        .map((s) => ({ url: s.url ?? '' }))
        .filter((s) => s.url.length > 0)
    : [];
  const operationCount = countOperations(parsed.paths);
  const contentHash = createHash('sha256').update(raw).digest('hex');

  if (!('x-ferrum-proxy' in parsed)) {
    throw badRequest(
      'missing_ferrum_proxy',
      'Spec is missing required `x-ferrum-proxy` extension. Add a proxy descriptor before publishing.',
    );
  }
  const proxyParse = FerrumProxySchema.safeParse(parsed['x-ferrum-proxy']);
  if (!proxyParse.success) {
    throw badRequest(
      'invalid_ferrum_proxy',
      'Invalid `x-ferrum-proxy` descriptor. It must include a `proxy_id` and at least one of `paths`, `hosts`, or `upstream_url`.',
      proxyParse.error.issues,
    );
  }
  if (
    !proxyParse.data.paths?.length &&
    !proxyParse.data.hosts?.length &&
    !proxyParse.data.upstream_url
  ) {
    throw badRequest(
      'invalid_ferrum_proxy',
      'x-ferrum-proxy must define at least one of paths/hosts/upstream_url.',
    );
  }
  rejectExternalRefs(parsed);

  return {
    title,
    version,
    description,
    tags,
    contact,
    servers,
    operationCount,
    contentHash,
    rawContentType: contentType,
  };
}

/**
 * Walk the parsed spec and reject any `$ref` whose target is an external URL.
 * Allowing external refs would let an uploaded spec coerce internal tooling
 * into fetching attacker-chosen URLs — a textbook SSRF vector.
 *
 * We allow:
 *   - fragment-only refs (`#/components/schemas/Foo`)
 *   - relative file refs (`./common.yaml`) which a downstream consumer might
 *     resolve locally; if you ship a spec validator that resolves these, swap
 *     the predicate below.
 *
 * We reject anything whose scheme is `http`/`https`.
 */
function rejectExternalRefs(node: unknown, depth = 0): void {
  if (depth > 100 || node == null) return;
  if (Array.isArray(node)) {
    for (const child of node) rejectExternalRefs(child, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === '$ref' && typeof value === 'string') {
      const lowered = value.trim().toLowerCase();
      if (lowered.startsWith('http://') || lowered.startsWith('https://') || lowered.startsWith('//')) {
        throw badRequest(
          'external_ref_forbidden',
          `Spec contains external $ref: ${value}. Inline the referenced content or use a fragment-only ($/components/...) reference.`,
        );
      }
    } else {
      rejectExternalRefs(value, depth + 1);
    }
  }
}

function countOperations(paths: unknown): number {
  if (!paths || typeof paths !== 'object') return 0;
  const ops = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'];
  let count = 0;
  for (const value of Object.values(paths)) {
    if (value && typeof value === 'object') {
      for (const op of ops) {
        if (op in (value as Record<string, unknown>)) count++;
      }
    }
  }
  return count;
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}
