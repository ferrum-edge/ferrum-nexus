import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CSRF_COOKIE, CSRF_HEADER, ERROR_CODES } from '@ferrum-nexus/shared';
import {
  ApiError,
  authApi,
  buildQuery,
  catalogApi,
  credentialsApi,
  readCookie,
  request,
  setUnauthorizedHandler,
} from './api';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function lastCall(): [string, RequestInit] {
  const mock = vi.mocked(globalThis.fetch);
  const call = mock.mock.calls.at(-1);
  if (!call) throw new Error('fetch was not called');
  return [String(call[0]), (call[1] ?? {}) as RequestInit];
}

describe('lib/api', () => {
  beforeEach(() => {
    document.cookie = `${CSRF_COOKIE}=csrf-token-value`;
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    setUnauthorizedHandler(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('attaches the CSRF header to non-GET requests', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse({ ok: true }));

    await credentialsApi.issue({ credential_type: 'keyauth' });

    const [url, init] = lastCall();
    expect(url).toBe('/api/credentials');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(new Headers(init.headers).get(CSRF_HEADER)).toBe('csrf-token-value');
  });

  it('does not attach the CSRF header to GET requests', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse({ items: [], total: 0 }));

    await catalogApi.list({ q: 'billing' });

    const [url, init] = lastCall();
    expect(url).toBe('/api/catalog?q=billing');
    expect(new Headers(init.headers).has(CSRF_HEADER)).toBe(false);
  });

  it('parses an ApiErrorBody into a thrown ApiError', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: ERROR_CODES.CONFLICT,
            message: 'An active grant already exists',
            details: { api_id: 'api-1' },
          },
        },
        409,
      ),
    );

    const error = await catalogApi.detail('billing').catch((caught: unknown) => caught);

    expect(ApiError.is(error)).toBe(true);
    const apiError = error as ApiError;
    expect(apiError.code).toBe(ERROR_CODES.CONFLICT);
    expect(apiError.status).toBe(409);
    expect(apiError.message).toBe('An active grant already exists');
    expect(apiError.details).toEqual({ api_id: 'api-1' });
    expect(ApiError.hasCode(apiError, ERROR_CODES.CONFLICT)).toBe(true);
  });

  it('falls back to a status-derived code when the body is not an error envelope', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response('gateway exploded', { status: 500 }),
    );

    const error = (await request('GET', '/health').catch((caught: unknown) => caught)) as ApiError;

    expect(error.code).toBe(ERROR_CODES.INTERNAL);
    expect(error.message).toBe('gateway exploded');
  });

  it('fires the unauthorized handler exactly once on a 401', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse({ error: { code: ERROR_CODES.UNAUTHORIZED, message: 'no session' } }, 401),
    );
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);

    const error = (await authApi.me().catch((caught: unknown) => caught)) as ApiError;

    expect(error.code).toBe(ERROR_CODES.UNAUTHORIZED);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('skips the unauthorized handler for the silent bootstrap probe', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse({ error: { code: ERROR_CODES.UNAUTHORIZED, message: 'no session' } }, 401),
    );
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);

    await authApi.meSilent().catch(() => undefined);

    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('builds query strings, dropping empty values', () => {
    expect(buildQuery({ limit: 25, offset: 0, q: '', mine: true, status: undefined })).toBe(
      '?limit=25&offset=0&mine=true',
    );
    expect(buildQuery(undefined)).toBe('');
  });

  it('reads cookies by name', () => {
    expect(readCookie(CSRF_COOKIE)).toBe('csrf-token-value');
    expect(readCookie('nexus_missing')).toBeNull();
  });
});
