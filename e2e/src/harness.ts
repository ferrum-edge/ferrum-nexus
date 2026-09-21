/**
 * Talking to the running end-to-end stack: the portal's HTTP API, the mail
 * sink, and the gateway's **data plane**.
 *
 * The distinction that matters here is the one the whole suite exists for. Every
 * other test in this repository asks the portal whether it thinks something is
 * true; these ask the gateway, by sending a request to the listener a real
 * client would send it to, and seeing whether it reached the upstream. So
 * {@link callGateway} never touches the Admin API, and {@link UPSTREAM_MARKER}
 * is the single signal meaning "this response came from the backend".
 */

import { setTimeout as delay } from 'node:timers/promises';

/** The header the deterministic upstream stamps on everything it serves. */
export const UPSTREAM_MARKER = 'x-upstream';

/** Where the compose stack publishes each surface, overridable per run. */
export const PORTAL_URL = process.env.E2E_PORTAL_URL ?? 'http://127.0.0.1:8787';
export const GATEWAY_URL = process.env.E2E_GATEWAY_URL ?? 'http://127.0.0.1:8000';
export const MAIL_URL = process.env.E2E_MAIL_URL ?? 'http://127.0.0.1:8025';
export const BOOTSTRAP_TOKEN = process.env.NEXUS_BOOTSTRAP_TOKEN ?? '';

/** How long a readiness wait may take before the run is declared failed. */
const READY_TIMEOUT_MS = Number(process.env.E2E_READY_TIMEOUT_MS ?? 120_000);
const POLL_INTERVAL_MS = 500;

/** A signed-in portal session: the two cookies and the CSRF header value. */
export interface Session {
  cookie: string;
  csrf: string;
  userId: string;
  email: string;
  /** The role the portal gave this account, as it reported it. */
  role?: string;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Poll `check` until it returns true, or fail with a message naming what was
 * being waited for.
 *
 * Every wait in this suite is bounded. A CI job that hangs until the runner
 * times out tells an operator nothing; one that says "the gateway data plane
 * never served /nexus/e2e-keyauth within 120s" tells them where to look.
 */
export async function waitFor(
  what: string,
  check: () => Promise<boolean>,
  timeoutMs = READY_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      if (await check()) return;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      const because = lastError instanceof Error ? `: ${lastError.message}` : '';
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}${because}`);
    }
    await delay(POLL_INTERVAL_MS);
  }
}

/** Cookie header value from a `set-cookie` list, keeping only what we need. */
function cookiesFrom(response: Response): { cookie: string; csrf: string } {
  const raw = response.headers.getSetCookie();
  const jar = new Map<string, string>();
  for (const entry of raw) {
    const [pair] = entry.split(';');
    const index = pair?.indexOf('=') ?? -1;
    if (!pair || index < 0) continue;
    jar.set(pair.slice(0, index), pair.slice(index + 1));
  }
  const session = jar.get('nexus_session');
  const csrf = jar.get('nexus_csrf');
  if (!session || !csrf) {
    throw new Error(`Response carried no session cookies (${[...jar.keys()].join(', ')})`);
  }
  return { cookie: `nexus_session=${session}; nexus_csrf=${csrf}`, csrf };
}

/** One call to the portal's API, as a signed-in session or anonymously. */
export async function portal<T>(
  method: string,
  path: string,
  options: { session?: Session; body?: unknown; expect?: number } = {},
): Promise<T> {
  const response = await portalRaw(method, path, options);
  const text = await response.text();
  const expected = options.expect ?? (method === 'POST' ? 201 : 200);
  if (response.status !== expected) {
    throw new HttpError(
      response.status,
      text,
      `${method} ${path} answered ${response.status}, expected ${expected}: ${text}`,
    );
  }
  return text === '' ? (undefined as T) : (JSON.parse(text) as T);
}

/** The same call, without asserting a status — for the refusal assertions. */
export async function portalRaw(
  method: string,
  path: string,
  options: { session?: Session; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.session) {
    headers.cookie = options.session.cookie;
    headers['x-nexus-csrf'] = options.session.csrf;
  }
  return fetch(`${PORTAL_URL}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

/**
 * A request through the **gateway's data plane** — the listener a real client
 * uses. Never the Admin API.
 */
export async function callGateway(
  path: string,
  init: RequestInit & { method?: string } = {},
): Promise<Response> {
  return fetch(`${GATEWAY_URL}${path}`, { redirect: 'manual', ...init });
}

/** Whether a gateway response actually reached the deterministic upstream. */
export function reachedUpstream(response: Response): boolean {
  return response.headers.get(UPSTREAM_MARKER) === 'ferrum-nexus-e2e';
}

/** One message from the mail sink, newest first. */
interface MailpitMessage {
  ID: string;
  To: { Address: string }[];
  Subject: string;
}

/**
 * The most recent message delivered to `address`, waited for.
 *
 * Verification mail is part of the journey under test — a portal that cannot
 * deliver it cannot onboard anybody — so the suite reads the real message out
 * of a real SMTP sink rather than reaching into the database for the token.
 */
export async function latestMailTo(address: string): Promise<{ subject: string; text: string }> {
  let found: MailpitMessage | undefined;
  await waitFor(`mail delivered to ${address}`, async () => {
    const response = await fetch(`${MAIL_URL}/api/v1/messages?limit=50`);
    if (!response.ok) return false;
    const body = (await response.json()) as { messages?: MailpitMessage[] };
    found = (body.messages ?? []).find((message) =>
      message.To.some((to) => to.Address.toLowerCase() === address.toLowerCase()),
    );
    return found !== undefined;
  });
  if (!found) throw new Error(`No message for ${address}`);
  const detail = await fetch(`${MAIL_URL}/api/v1/message/${found.ID}`);
  const body = (await detail.json()) as { Subject: string; Text?: string; HTML?: string };
  return { subject: body.Subject, text: `${body.Text ?? ''}\n${body.HTML ?? ''}` };
}

/** Forget every delivered message, so a later wait cannot match an old one. */
export async function clearMail(): Promise<void> {
  await fetch(`${MAIL_URL}/api/v1/messages`, { method: 'DELETE' });
}

/** What `POST /api/auth/register` answers. */
interface RegisterResult {
  user: { id: string; email: string; role: string; email_verified: boolean };
  email_verification_required: boolean;
}

/**
 * Register an account, verify it through the real mail, and sign in.
 *
 * The mail step is skipped when the portal says verification was not required
 * — which is the case for the very first account, and for every account until
 * an administrator turns the policy on. Waiting for a message the portal was
 * never going to send would turn a policy difference into a two-minute hang.
 */
export async function registerVerifiedUser(
  email: string,
  role: 'client' | 'provider',
  options: { bootstrap?: boolean } = {},
): Promise<Session> {
  const password = 'correct-horse-battery-staple';
  const registered = await portal<RegisterResult>('POST', '/api/auth/register', {
    body: {
      email,
      password,
      display_name: email.split('@')[0],
      role,
      ...(options.bootstrap ? { bootstrap_token: BOOTSTRAP_TOKEN } : {}),
    },
  });

  if (registered.email_verification_required) {
    // The verification link, out of the real message. A portal that stopped
    // sending it would fail here rather than in production.
    const mail = await latestMailTo(email);
    const token = /[?&]token=([A-Za-z0-9._~-]+)/.exec(mail.text)?.[1];
    if (!token) throw new Error(`No verification token in the mail to ${email}: ${mail.subject}`);
    await portal('POST', '/api/auth/verify-email', { body: { token }, expect: 200 });
  }

  const session = await signIn(email, password);
  return { ...session, role: registered.user.role };
}

/** Sign in and capture the session. */
export async function signIn(email: string, password: string): Promise<Session> {
  const response = await portalRaw('POST', '/api/auth/login', { body: { email, password } });
  const text = await response.text();
  if (response.status !== 200) {
    throw new HttpError(response.status, text, `Login for ${email} failed: ${text}`);
  }
  const { cookie, csrf } = cookiesFrom(response);
  const body = JSON.parse(text) as { user: { id: string; email: string; role: string } };
  return {
    cookie,
    csrf,
    userId: body.user.id,
    email: body.user.email,
    role: body.user.role,
  };
}

/** Wait until the portal, the gateway's data plane and the sink all answer. */
export async function waitForStack(): Promise<void> {
  await waitFor('the portal to report a database', async () => {
    const response = await fetch(`${PORTAL_URL}/api/health`);
    return response.status === 200;
  });
  await waitFor('the portal to report a reachable gateway', async () => {
    const response = await fetch(`${PORTAL_URL}/api/health`);
    if (!response.ok) return false;
    const body = (await response.json()) as { edge?: { status?: string } };
    return body.edge?.status === 'ok';
  });
  // The data plane answers 404 for an unpublished path, which is exactly the
  // proof that it is listening.
  await waitFor('the gateway data plane to listen', async () => {
    const response = await callGateway('/__e2e_readiness__');
    return response.status > 0;
  });
  await waitFor('the mail sink to answer', async () => {
    const response = await fetch(`${MAIL_URL}/api/v1/messages?limit=1`);
    return response.ok;
  });
}
