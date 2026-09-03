import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SpecPath } from './oas.js';
import { validatorConfigFor } from './spec-enforcement.js';

/** The generated config, narrowed to the shape the assertions read. */
interface Generated {
  enforcement_mode: string;
  validate_request: boolean;
  validate_response: boolean;
  fail_on_unknown_operation: boolean;
  operations: { method: string; path_template: string; path_regex: string }[];
  bypass?: { methods?: string[] };
}

function generate(
  paths: SpecPath[],
  listenPath = '/nexus/billing',
  hasCors = false,
): Generated | null {
  return validatorConfigFor(paths, listenPath, { hasCors }) as Generated | null;
}

/** The one operation a single-path/single-method document produces. */
function onlyOperation(paths: SpecPath[], listenPath?: string): Generated['operations'][number] {
  const config = generate(paths, listenPath);
  assert.ok(config, 'expected a config');
  assert.equal(config.operations.length, 1);
  return config.operations[0] as Generated['operations'][number];
}

/**
 * Does `path_regex` accept `candidate`?
 *
 * JavaScript's engine is not Rust's, but the constructs the generator emits
 * (`^`, `$`, `[^/]+`, and escaped literals) mean the same thing in both, so
 * this is a fair check that the *enforced surface* is what it claims.
 */
function matches(regex: string, candidate: string): boolean {
  return new RegExp(regex).test(candidate);
}

describe('validatorConfigFor', () => {
  it('emits the routes-only key set and nothing else', () => {
    const config = generate([{ path: '/invoices', methods: ['GET'] }]);
    assert.ok(config);
    assert.deepEqual(config, {
      enforcement_mode: 'block',
      validate_request: false,
      validate_response: false,
      fail_on_unknown_operation: true,
      operations: [
        {
          method: 'GET',
          path_template: '/nexus/billing/invoices',
          path_regex: '^/nexus/billing/invoices$',
        },
      ],
    });
    // Body validation is out of scope at this level; asserting the absence of
    // the schema keys is asserting the feature's boundary, not just its shape.
    assert.equal('request_content_types' in config, false);
    assert.equal('schema_draft' in config, false);
  });

  it('prefixes every operation with the listen path', () => {
    const operation = onlyOperation([{ path: '/invoices', methods: ['GET'] }], '/nexus/shipping');
    assert.equal(operation.path_template, '/nexus/shipping/invoices');
    assert.equal(operation.path_regex, '^/nexus/shipping/invoices$');
    assert.equal(matches(operation.path_regex, '/nexus/shipping/invoices'), true);
    // The spec path alone is not the canonical policy path Edge matches on.
    assert.equal(matches(operation.path_regex, '/invoices'), false);
  });

  it('widens a path parameter to a single non-separator segment', () => {
    const operation = onlyOperation([{ path: '/invoices/{id}', methods: ['GET'] }]);
    assert.equal(operation.path_template, '/nexus/billing/invoices/{id}');
    assert.equal(operation.path_regex, '^/nexus/billing/invoices/[^/]+$');
    assert.equal(matches(operation.path_regex, '/nexus/billing/invoices/42'), true);
    // A parameter must not swallow a separator and reach a deeper operation.
    assert.equal(matches(operation.path_regex, '/nexus/billing/invoices/42/lines'), false);
    assert.equal(matches(operation.path_regex, '/nexus/billing/invoices/'), false);
  });

  it('handles several parameters and literal text between them', () => {
    const operation = onlyOperation([
      { path: '/orgs/{orgId}/invoices/{id}/lines', methods: ['GET'] },
    ]);
    assert.equal(operation.path_regex, '^/nexus/billing/orgs/[^/]+/invoices/[^/]+/lines$');
    assert.equal(matches(operation.path_regex, '/nexus/billing/orgs/acme/invoices/7/lines'), true);
    assert.equal(matches(operation.path_regex, '/nexus/billing/orgs/acme/invoices/7'), false);
  });

  it('escapes regex metacharacters in literal path segments', () => {
    const operation = onlyOperation([{ path: '/files/report.pdf', methods: ['GET'] }]);
    assert.equal(operation.path_regex, '^/nexus/billing/files/report\\.pdf$');
    assert.equal(matches(operation.path_regex, '/nexus/billing/files/report.pdf'), true);
    // Without the escape a `.` would match any character, which is the whole
    // point: `/files/reportXpdf` must not reach the backend.
    assert.equal(matches(operation.path_regex, '/nexus/billing/files/reportXpdf'), false);
  });

  it('escapes the rest of the Rust regex metacharacter set', () => {
    const operation = onlyOperation([
      { path: '/a+b/c(d)/e|f/g[h]/i-j/k#l/m&n/o~p', methods: ['GET'] },
    ]);
    assert.equal(
      operation.path_regex,
      '^/nexus/billing/a\\+b/c\\(d\\)/e\\|f/g\\[h\\]/i\\-j/k\\#l/m\\&n/o\\~p$',
    );
    assert.equal(
      matches(operation.path_regex, '/nexus/billing/a+b/c(d)/e|f/g[h]/i-j/k#l/m&n/o~p'),
      true,
    );
  });

  it('leaves the separator unescaped, as regex::escape does', () => {
    // `/` is not a metacharacter in Rust's regex crate, and Edge's own importer
    // does not escape it — a `\/` here would read as a needless divergence.
    const operation = onlyOperation([{ path: '/a/b', methods: ['GET'] }]);
    assert.equal(operation.path_regex.includes('\\/'), false);
  });

  it('keeps a trailing slash literal', () => {
    const operation = onlyOperation([{ path: '/invoices/', methods: ['GET'] }]);
    assert.equal(operation.path_template, '/nexus/billing/invoices/');
    assert.equal(operation.path_regex, '^/nexus/billing/invoices/$');
    assert.equal(matches(operation.path_regex, '/nexus/billing/invoices/'), true);
    // A declared `/invoices/` does not silently also declare `/invoices`.
    assert.equal(matches(operation.path_regex, '/nexus/billing/invoices'), false);
  });

  it('escapes metacharacters in the listen path too', () => {
    const operation = onlyOperation([{ path: '/invoices', methods: ['GET'] }], '/nexus/v1.0-api');
    assert.equal(operation.path_regex, '^/nexus/v1\\.0\\-api/invoices$');
    assert.equal(matches(operation.path_regex, '/nexus/v1.0-api/invoices'), true);
    assert.equal(matches(operation.path_regex, '/nexus/v1X0-api/invoices'), false);
  });

  it('emits one operation per method, in document order', () => {
    const config = generate([
      { path: '/invoices', methods: ['GET', 'POST'] },
      { path: '/invoices/{id}', methods: ['GET', 'DELETE'] },
    ]);
    assert.ok(config);
    assert.deepEqual(
      config.operations.map((operation) => `${operation.method} ${operation.path_template}`),
      [
        'GET /nexus/billing/invoices',
        'POST /nexus/billing/invoices',
        'GET /nexus/billing/invoices/{id}',
        'DELETE /nexus/billing/invoices/{id}',
      ],
    );
  });

  it('declares no operation for a method the document omits', () => {
    const config = generate([{ path: '/invoices', methods: ['GET'] }]);
    assert.ok(config);
    // `HEAD` is the one providers are most surprised by: it is a separate
    // OpenAPI operation key, so a document that only declares `get` does not
    // declare `head`, and Edge rejects it.
    assert.equal(
      config.operations.some((operation) => operation.method === 'HEAD'),
      false,
    );
  });

  it('bypasses OPTIONS only when the API has a CORS policy', () => {
    const withCors = generate([{ path: '/invoices', methods: ['GET'] }], '/nexus/billing', true);
    assert.ok(withCors);
    assert.deepEqual(withCors.bypass, { methods: ['OPTIONS'] });

    const withoutCors = generate([{ path: '/invoices', methods: ['GET'] }]);
    assert.ok(withoutCors);
    assert.equal('bypass' in withoutCors, false);
  });

  it('keeps a declared OPTIONS operation alongside the CORS bypass', () => {
    const config = generate(
      [{ path: '/invoices', methods: ['GET', 'OPTIONS'] }],
      '/nexus/billing',
      true,
    );
    assert.ok(config);
    assert.equal(config.operations.length, 2);
    assert.deepEqual(config.bypass, { methods: ['OPTIONS'] });
  });

  it('returns null when the document declares nothing to enforce', () => {
    // Edge rejects an empty `operations` array, so "no plugin at all" is the
    // only representable answer — and the safe one.
    assert.equal(generate([]), null);
  });

  it('treats a brace group that is not a parameter as literal text', () => {
    // Edge's importer rejects these outright; escaping them narrows the
    // enforced surface instead of widening it.
    const empty = onlyOperation([{ path: '/a/{}/b', methods: ['GET'] }]);
    assert.equal(empty.path_regex, '^/nexus/billing/a/\\{\\}/b$');
    assert.equal(matches(empty.path_regex, '/nexus/billing/a/{}/b'), true);
    assert.equal(matches(empty.path_regex, '/nexus/billing/a/anything/b'), false);

    const unclosed = onlyOperation([{ path: '/a/{id', methods: ['GET'] }]);
    assert.equal(unclosed.path_regex, '^/nexus/billing/a/\\{id$');

    const blank = onlyOperation([{ path: '/a/{ }/b', methods: ['GET'] }]);
    assert.equal(blank.path_regex, '^/nexus/billing/a/\\{ \\}/b$');
  });

  it('still widens a real parameter that follows a malformed brace group', () => {
    const operation = onlyOperation([{ path: '/a/{}/{id}', methods: ['GET'] }]);
    assert.equal(operation.path_regex, '^/nexus/billing/a/\\{\\}/[^/]+$');
    assert.equal(matches(operation.path_regex, '/nexus/billing/a/{}/42'), true);
  });
});
