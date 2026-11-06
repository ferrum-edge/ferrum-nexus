const AMPERSAND = /&/g;
const LESS_THAN = /</g;
const GREATER_THAN = />/g;
const DOUBLE_QUOTE = /"/g;
const SINGLE_QUOTE = /'/g;

/** Escape text for interpolation into an HTML body. */
export function escapeHtml(value: string): string {
  return value
    .replace(AMPERSAND, '&amp;')
    .replace(LESS_THAN, '&lt;')
    .replace(GREATER_THAN, '&gt;')
    .replace(DOUBLE_QUOTE, '&quot;')
    .replace(SINGLE_QUOTE, '&#39;');
}
