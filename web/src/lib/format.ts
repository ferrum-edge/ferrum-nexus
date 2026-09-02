/** Presentation helpers shared across pages. */

/** Format an ISO timestamp as a locale date+time, or an em dash when absent. */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Format an ISO timestamp as a locale date only. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
}

const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 60 * 60 * 1000],
  ['month', 30 * 24 * 60 * 60 * 1000],
  ['day', 24 * 60 * 60 * 1000],
  ['hour', 60 * 60 * 1000],
  ['minute', 60 * 1000],
];

/** Format an ISO timestamp as a coarse relative time ("3 hours ago"). */
export function formatRelative(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const deltaMs = date.getTime() - Date.now();
  const abs = Math.abs(deltaMs);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, ms] of RELATIVE_UNITS) {
    if (abs >= ms) return formatter.format(Math.round(deltaMs / ms), unit);
  }
  return formatter.format(Math.round(deltaMs / 1000), 'second');
}

/** Turn a free-text API name into a URL-safe slug. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/** Turn a snake_case identifier into a human-readable label. */
export function humanize(value: string): string {
  const spaced = value.replace(/[_.]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Compact byte-size rendering for uploaded specs. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Truncate a string for previews, appending an ellipsis when cut. */
export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * Split a CORS origins box into individual origins.
 *
 * One per line is what the forms ask for, but commas are split too: a provider
 * pasting an origin list out of another config would otherwise submit a single
 * entry, which the server rejects for containing whitespace.
 */
export function parseCorsOrigins(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}
