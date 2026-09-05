const SENSITIVE_QUERY_PARAMS = new Set([
  'token',
  'code',
  'state',
  'key',
  'secret',
  'signature',
  'access_token',
  'refresh_token',
  'api_key',
  'password',
]);

/**
 * Redact query credentials without parsing/re-encoding the URL or its values.
 * Paths and diagnostic parameters keep their original spelling. Only parameter
 * names need decoding; an invalid name is conservatively treated as sensitive.
 * Requests without a query take the allocation-free fast path.
 */
export function sanitizeUrlForLog(url: string): string {
  const queryStart = url.indexOf('?');
  if (queryStart === -1) return url;

  let result = '';
  let copiedThrough = 0;
  let start = queryStart + 1;
  while (start < url.length) {
    const ampersand = url.indexOf('&', start);
    const end = ampersand === -1 ? url.length : ampersand;
    const parameter = url.slice(start, end);
    const equals = parameter.indexOf('=');
    if (equals !== -1) {
      const rawName = parameter.slice(0, equals);
      let sensitive = true;
      try {
        const name = rawName.includes('%') ? decodeURIComponent(rawName) : rawName;
        sensitive = SENSITIVE_QUERY_PARAMS.has(name.toLowerCase());
      } catch {
        // Malformed percent escapes must never throw from a logger.
      }
      if (sensitive) {
        result += url.slice(copiedThrough, start + equals + 1) + '[Redacted]';
        copiedThrough = end;
      }
    }
    start = end + 1;
  }
  return copiedThrough === 0 ? url : result + url.slice(copiedThrough);
}
