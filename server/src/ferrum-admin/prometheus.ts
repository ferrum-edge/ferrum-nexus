/**
 * A small, tolerant reader for the Prometheus text exposition format.
 *
 * This lives inside `ferrum-admin/` because the exposition body of Edge's
 * `GET /metrics` is part of Edge's HTTP shape, and nothing above this module is
 * allowed to know it.
 *
 * "Tolerant" is the whole design brief. A scrape is a *diagnostic*: Nexus
 * renders it on a provider's overview card, and a gateway upgrade that adds a
 * family, an exemplar, or a label Nexus has never seen must degrade to "that
 * line was skipped", never to a 500 on an API detail page. So:
 *
 * - `# HELP` / `# TYPE` / any other comment line is dropped without inspection;
 * - a line that does not parse is skipped, and the rest of the body still
 *   yields samples;
 * - unknown families and unknown labels are returned as-is and filtered by the
 *   caller, rather than being rejected here;
 * - nothing in this file throws.
 *
 * What it does *not* implement, deliberately: OpenMetrics exemplars (the ` # `
 * tail is ignored), `{"quoted_metric_name"}` UTF-8 names, and the
 * `_created`/`_total` suffix normalisation rules. Edge emits none of them on
 * the two families Nexus reads.
 */

/** One parsed exposition line. */
export interface PrometheusSample {
  /** Family name including any `_bucket` / `_sum` / `_count` suffix. */
  name: string;
  /** Label set; empty when the series carries no labels. */
  labels: Record<string, string>;
  /**
   * Sample value. `+Inf` / `-Inf` / `NaN` parse to the matching JS number, so a
   * caller comparing against a threshold must guard with `Number.isFinite`.
   */
  value: number;
}

/** Prometheus metric and label names: `[a-zA-Z_:][a-zA-Z0-9_:]*`. */
const NAME_START = /[a-zA-Z_:]/;
const NAME_CHAR = /[a-zA-Z0-9_:]/;

/**
 * Parse a metric or label name starting at `from`.
 *
 * Returns the name and the index just past it, or `null` when the first
 * character cannot start a name.
 */
function readName(line: string, from: number): { name: string; next: number } | null {
  if (from >= line.length || !NAME_START.test(line[from] as string)) return null;
  let index = from + 1;
  while (index < line.length && NAME_CHAR.test(line[index] as string)) index += 1;
  return { name: line.slice(from, index), next: index };
}

/**
 * Read a double-quoted label value starting at the opening quote.
 *
 * The escape set is the one the exposition format defines — `\\`, `\"` and
 * `\n`. Any other escaped character is emitted verbatim (so a stray `\t`
 * becomes `t`, matching how Prometheus' own parser is forgiving here) rather
 * than aborting the line.
 */
function readQuoted(line: string, from: number): { value: string; next: number } | null {
  if (line[from] !== '"') return null;
  let value = '';
  let index = from + 1;
  while (index < line.length) {
    const char = line[index] as string;
    if (char === '\\') {
      const escaped = line[index + 1];
      if (escaped === undefined) return null;
      value += escaped === 'n' ? '\n' : escaped;
      index += 2;
      continue;
    }
    if (char === '"') return { value, next: index + 1 };
    value += char;
    index += 1;
  }
  // Unterminated quote — the line is unusable.
  return null;
}

function skipSpace(line: string, from: number): number {
  let index = from;
  while (index < line.length && (line[index] === ' ' || line[index] === '\t')) index += 1;
  return index;
}

/**
 * Parse the `{…}` label block starting at the opening brace.
 *
 * A trailing comma before `}` is accepted, as the format allows.
 */
function readLabels(
  line: string,
  from: number,
): { labels: Record<string, string>; next: number } | null {
  if (line[from] !== '{') return null;
  const labels: Record<string, string> = {};
  let index = skipSpace(line, from + 1);

  if (line[index] === '}') return { labels, next: index + 1 };

  for (;;) {
    const key = readName(line, index);
    if (!key) return null;
    index = skipSpace(line, key.next);
    if (line[index] !== '=') return null;
    index = skipSpace(line, index + 1);
    const value = readQuoted(line, index);
    if (!value) return null;
    labels[key.name] = value.value;
    index = skipSpace(line, value.next);

    if (line[index] === ',') {
      index = skipSpace(line, index + 1);
      // Trailing comma.
      if (line[index] === '}') return { labels, next: index + 1 };
      continue;
    }
    if (line[index] === '}') return { labels, next: index + 1 };
    return null;
  }
}

/**
 * Parse a sample value.
 *
 * `Number()` already handles `Infinity`, decimals and exponents; the explicit
 * cases cover the exposition spellings `+Inf` / `-Inf` / `NaN`, and the empty
 * string is rejected because `Number('')` is `0`.
 */
function parseValue(token: string): number | null {
  if (token === '') return null;
  if (token === '+Inf' || token === 'Inf') return Number.POSITIVE_INFINITY;
  if (token === '-Inf') return Number.NEGATIVE_INFINITY;
  if (token === 'NaN') return Number.NaN;
  const value = Number(token);
  return Number.isNaN(value) ? null : value;
}

/**
 * Parse a Prometheus text exposition body into samples.
 *
 * Never throws: an unparseable line is skipped, and an entirely unparseable
 * body yields an empty array.
 */
export function parsePrometheusText(body: string): PrometheusSample[] {
  const samples: PrometheusSample[] = [];

  for (const rawLine of body.split('\n')) {
    const line = rawLine.trimEnd();
    const start = skipSpace(line, 0);
    if (start >= line.length) continue;
    // `# HELP`, `# TYPE`, `# EOF`, and any other comment.
    if (line[start] === '#') continue;

    const name = readName(line, start);
    if (!name) continue;

    let index = name.next;
    let labels: Record<string, string> = {};
    if (line[index] === '{') {
      const parsed = readLabels(line, index);
      if (!parsed) continue;
      labels = parsed.labels;
      index = parsed.next;
    }

    index = skipSpace(line, index);
    if (index >= line.length) continue;

    // Value, then an optional timestamp (and an optional OpenMetrics exemplar),
    // both of which Nexus ignores.
    let end = index;
    while (end < line.length && line[end] !== ' ' && line[end] !== '\t') end += 1;
    const value = parseValue(line.slice(index, end));
    if (value === null) continue;

    samples.push({ name: name.name, labels, value });
  }

  return samples;
}
