import { MAX_UPSTREAM_URL_LENGTH, parseAbsoluteHttpUrl } from '@ferrum-nexus/shared';

/**
 * Why `text` is not an upstream URL the server would accept, or `null` when it
 * is, or when it is blank (the caller decides what a blank field means).
 *
 * The same two checks the server makes on a typed upstream: the trimmed text is
 * at most {@link MAX_UPSTREAM_URL_LENGTH} characters, and it parses as an
 * absolute `http://` or `https://` URL ({@link parseAbsoluteHttpUrl}). Shared
 * by the publish form and the API settings form so neither finds out only
 * after a save round trip (issue #661).
 */
export function upstreamUrlProblem(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (trimmed.length > MAX_UPSTREAM_URL_LENGTH || !parseAbsoluteHttpUrl(trimmed)) {
    return `Enter an absolute http:// or https:// URL of at most ${MAX_UPSTREAM_URL_LENGTH} characters.`;
  }
  return null;
}
