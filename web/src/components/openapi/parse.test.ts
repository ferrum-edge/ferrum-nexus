import { describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseSpecText } from './parse';

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
