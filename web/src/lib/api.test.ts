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
  threadsApi,
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

  it('posts the password recovery bodies to their routes', async () => {
    // A Response body can only be read once, so each call needs a fresh one.
    vi.mocked(globalThis.fetch).mockImplementation(() =>
      Promise.resolve(jsonResponse({ ok: true })),
    );

    await expect(authApi.forgotPassword({ email: 'someone@example.test' })).resolves.toEqual({
      ok: true,
    });
    const [forgotUrl, forgotInit] = lastCall();
    expect(forgotUrl).toBe('/api/auth/forgot-password');
    expect(forgotInit.method).toBe('POST');
    expect(JSON.parse(String(forgotInit.body))).toEqual({ email: 'someone@example.test' });

    await authApi.resetPassword({ token: 'tok-123', new_password: 'a-long-enough-password' });
    const [resetUrl, resetInit] = lastCall();
    expect(resetUrl).toBe('/api/auth/reset-password');
    expect(JSON.parse(String(resetInit.body))).toEqual({
      token: 'tok-123',
      new_password: 'a-long-enough-password',
    });

    await authApi.resendVerification({ email: 'someone@example.test' });
    const [resendUrl, resendInit] = lastCall();
    expect(resendUrl).toBe('/api/auth/resend-verification');
    expect(resendInit.method).toBe('POST');
  });

  it('does not fire the unauthorized handler for a rate-limited reset request', async () => {
    // These three routes are reachable without a session; a 429 from the
    // `/api/auth/*` limiter must not be mistaken for a dead session.
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse({ error: { code: ERROR_CODES.RATE_LIMITED, message: 'slow down' } }, 429),
    );
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);

    const error = (await authApi
      .forgotPassword({ email: 'someone@example.test' })
      .catch((caught: unknown) => caught)) as ApiError;

    expect(error.code).toBe(ERROR_CODES.RATE_LIMITED);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('asks for one older window of a conversation by cursor', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse({ items: [], total: 0, has_more: false, next_before: null }),
    );

    await threadsApi.messages('thread 1', { before: 'message 2', limit: 25 });

    const [url] = lastCall();
    expect(url).toBe('/api/threads/thread%201/messages?before=message+2&limit=25');
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
