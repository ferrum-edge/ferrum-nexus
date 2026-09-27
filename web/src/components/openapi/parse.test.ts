import { describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { MAX_SPEC_BYTES } from '@ferrum-nexus/shared';
import {
  displayedRef,
  displayText,
  MAX_DISPLAYED_REF_LENGTH,
  parseSpecText,
  TRUNCATED_TEXT_HINT,
  truncateDisplayText,
} from './parse';

// The YAML parser is spied on rather than timed: the defect this guards is not
// "YAML is slow" but "a JSON document was handed to the YAML parser at all",
// whose cost is quadratic in the width of a flow mapping and freezes the tab.
vi.mock('yaml', async (importOriginal) => {
  const actual = await importOriginal<typeof import('yaml')>();
  return { ...actual, parse: vi.fn(actual.parse) };
});

/**
 * A JSON document whose single operation declares one very wide flow mapping —
 * the shape whose YAML parse is quadratic while its JSON parse is linear.
 */
function wideJsonSpec(properties: number): string {
  const schema: Record<string, unknown> = {};
  for (let index = 0; index < properties; index += 1) {
    schema[`property_${index}`] = { type: 'string' };
  }
  return JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'Wide API', version: '1.0.0' },
    paths: {
      '/things': { get: { responses: { '200': { description: 'ok' } } } },
    },
    components: { schemas: { Wide: { type: 'object', properties: schema } } },
  });
}

describe('parseSpecText', () => {
  it('parses a JSON document with JSON.parse, never through the YAML parser', () => {
    vi.mocked(parseYaml).mockClear();

    const result = parseSpecText(wideJsonSpec(20_000));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.title).toBe('Wide API');
    expect(result.spec.schemaNames).toEqual(['Wide']);
    expect(parseYaml).not.toHaveBeenCalled();
  });

  it('refuses a document over the byte limit without parsing it', () => {
    vi.mocked(parseYaml).mockClear();
    const json = vi.spyOn(JSON, 'parse');

    // Under the limit in UTF-16 code units, over it in UTF-8 bytes.
    const yaml = `openapi: 3.0.3\ninfo:\n  title: ${'é'.repeat(MAX_SPEC_BYTES / 2)}\npaths: {}\n`;
    const result = parseSpecText(yaml);
    const jsonResult = parseSpecText(`{"openapi":"${'a'.repeat(MAX_SPEC_BYTES)}"}`);

    expect(result).toEqual({
      ok: false,
      error: 'The specification is larger than the 2.00 MB limit.',
    });
    expect(jsonResult.ok).toBe(false);
    expect(parseYaml).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
    json.mockRestore();
  });

  it('still parses YAML, which is what anything not opening with { or [ is', () => {
    vi.mocked(parseYaml).mockClear();

    const lines = ['openapi: 3.0.3', 'info:', '  title: YAML API', "  version: '1.0.0'"];
    const result = parseSpecText([...lines, 'paths: {}'].join('\n'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.title).toBe('YAML API');
    expect(parseYaml).toHaveBeenCalledTimes(1);
  });

  it('reports a JSON syntax error as one instead of retrying it as YAML', () => {
    vi.mocked(parseYaml).mockClear();

    const result = parseSpecText('{ "openapi": "3.0.3", }');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Could not parse the specification as JSON/);
    expect(parseYaml).not.toHaveBeenCalled();
  });

  it('deduplicates operation tags before creating grouped card entries', () => {
    const result = parseSpecText(
      JSON.stringify({
        openapi: '3.0.3',
        info: { title: 'Tagged API', version: '1.0.0' },
        paths: {
          '/things': {
            get: {
              tags: Array.from({ length: 200 }, () => 'Things'),
              responses: { '200': { description: 'ok' } },
            },
          },
        },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.groups).toHaveLength(1);
    expect(result.spec.groups[0]?.operations).toHaveLength(1);
    expect(result.spec.groups[0]?.operations[0]?.tags).toEqual(['Things']);
  });
});

/** A high surrogate with no low surrogate after it — a character cut in half. */
const LONE_HIGH_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;

describe('truncateDisplayText', () => {
  it('returns text within the limit unchanged, without an ellipsis', () => {
    expect(truncateDisplayText('abc', 3)).toBe('abc');
    expect(truncateDisplayText('', 3)).toBe('');
  });

  it('cuts text past the limit and marks the cut', () => {
    expect(truncateDisplayText('abcdef', 3)).toBe('abc…');
  });

  it('never splits a surrogate pair at the boundary', () => {
    // U+1F600 is two UTF-16 code units, at indices 2 and 3.
    const text = 'ab\u{1F600}cd';

    expect(truncateDisplayText(text, 3)).toBe('ab…');
    expect(truncateDisplayText(text, 4)).toBe('ab\u{1F600}…');
    expect(truncateDisplayText(text, 3)).not.toMatch(LONE_HIGH_SURROGATE);
  });

  it('keeps a displayed $ref free of half characters', () => {
    const ref = `#/${'x'.repeat(MAX_DISPLAYED_REF_LENGTH - 3)}\u{1F600}tail`;

    const shown = displayedRef(ref);

    expect(shown).not.toMatch(LONE_HIGH_SURROGATE);
    expect(shown).toBe(`#/${'x'.repeat(MAX_DISPLAYED_REF_LENGTH - 3)}…`);
  });
});

describe('displayText', () => {
  it('titles only text it cut', () => {
    expect(displayText('short', 10)).toEqual({ text: 'short', title: undefined });
    expect(displayText('x'.repeat(11), 10)).toEqual({
      text: `${'x'.repeat(10)}…`,
      title: TRUNCATED_TEXT_HINT,
    });
  });

  it('returns null for absent or empty text', () => {
    expect(displayText(null, 10)).toBeNull();
    expect(displayText('', 10)).toBeNull();
  });
});
