/**
 * Tiny typed wrapper around `fetch` for talking to the Nexus BFF.
 *
 * All mutations include the CSRF token from the `nexus_csrf` cookie which the
 * server sets alongside the session cookie. Errors are normalized so callers
 * receive `{ status, code, message }`.
 */

import { CSRF_COOKIE, CSRF_HEADER } from '@ferrum-nexus/shared';

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/api';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]!) : null;
}

export async function api<T>(
  path: string,
  init: RequestInit & { json?: unknown; query?: Record<string, string | number | boolean | undefined> } = {},
): Promise<T> {
  const url = new URL(BASE + path, window.location.origin);
  if (init.query) {
    for (const [key, value] of Object.entries(init.query)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }
  const headers = new Headers(init.headers);
  if (init.json !== undefined) {
    headers.set('content-type', 'application/json');
    init.body = JSON.stringify(init.json);
  }
  const method = (init.method ?? 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    // Before any anonymous mutation (login, register, password reset) we may
    // not yet have a CSRF cookie. Bootstrap one transparently so the caller
    // doesn't have to remember to do this on every page. Authenticated
    // sessions already have the cookie set during /auth/login.
    let token = readCookie(CSRF_COOKIE);
    if (!token) {
      await fetch(new URL(BASE + '/csrf-token', window.location.origin), {
        credentials: 'include',
      });
      token = readCookie(CSRF_COOKIE);
    }
    if (token) headers.set(CSRF_HEADER, token);
  }
  const res = await fetch(url, { ...init, headers, credentials: 'include' });
  if (res.status === 204) return undefined as unknown as T;
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const errorBody = body as
      | { error?: { code?: string; message?: string; details?: unknown } }
      | undefined;
    throw new ApiError(
      res.status,
      errorBody?.error?.code ?? 'error',
      errorBody?.error?.message ?? res.statusText,
      errorBody?.error?.details,
    );
  }
  return body as T;
}
