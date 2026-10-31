/**
 * The portal-side setup every data-plane assertion is written against.
 *
 * Kept apart from the assertions because building it is not the test: a
 * provider publishes, a client is approved, a credential is issued. Each helper
 * does exactly that through the portal's **public API**, so nothing here
 * reaches around the product to arrange a state a real operator could not.
 */

import { createHmac } from 'node:crypto';

// E2E installs independently, so read the canonical type without a shared/dist build.
import type { ApiAgents } from '../../shared/src/agents.js';
import { portal, type Session } from './harness.js';

/** A published API as the portal describes it. */
export interface PublishedApi {
  agents?: ApiAgents | null;
  id: string;
  slug: string;
  listen_path: string;
  invoke_url: string | null;
}

/**
 * Where the deterministic upstream lives on the container network.
 *
 * The compose service name by default; overridable so the suite can be pointed
 * at a stack that was brought up some other way.
 */
export const UPSTREAM_URL = process.env.E2E_UPSTREAM_URL ?? 'http://upstream:9100';

/** The OpenAPI document every end-to-end API is published from. */
export function specFor(paths: string[], upstream = UPSTREAM_URL): string {
  const document: Record<string, unknown> = {
    openapi: '3.1.0',
    info: { title: 'E2E API', version: '1.0.0' },
    servers: [{ url: upstream }],
    paths: Object.fromEntries(
      paths.map((path) => [path, { get: { responses: { '200': { description: 'OK' } } } }]),
    ),
  };
  return JSON.stringify(document);
}

/** Publish one API as `provider`. */
export async function publishApi(
  provider: Session,
  input: {
    name: string;
    slug: string;
    authPlugin: 'key_auth' | 'basic_auth' | 'jwt_auth';
    enforcement?: 'docs_only' | 'routes';
    paths?: string[];
    requestable?: boolean;
    cors?: { allowed_origins: string[]; allow_credentials?: boolean };
    upstream?: string;
  },
): Promise<PublishedApi> {
  const body = await portal<{ api: PublishedApi }>('POST', '/api/apis', {
    session: provider,
    body: {
      name: input.name,
      slug: input.slug,
      spec: specFor(input.paths ?? ['/invoices'], input.upstream),
      auth_plugin: input.authPlugin,
      requestable: input.requestable ?? true,
      visibility: 'public',
      spec_enforcement: input.enforcement ?? 'docs_only',
      ...(input.cors ? { cors: input.cors } : {}),
    },
  });
  return body.api;
}

/** Request access as `client` and approve it as `provider`. */
export async function grantAccess(
  client: Session,
  provider: Session,
  apiId: string,
  applicationId?: string,
): Promise<{ requestId: string; grantId: string }> {
  const requested = await portal<{ access_request: { id: string } }>(
    'POST',
    '/api/access-requests',
    {
      session: client,
      body: {
        api_id: apiId,
        justification: 'End-to-end acceptance run',
        ...(applicationId ? { application_id: applicationId } : {}),
      },
    },
  );
  const approved = await portal<{ grant: { id: string } }>(
    'POST',
    `/api/access-requests/${requested.access_request.id}/approve`,
    { session: provider, body: {}, expect: 200 },
  );
  return { requestId: requested.access_request.id, grantId: approved.grant.id };
}

/** The show-once material, exactly as a client receives it. */
export interface IssuedCredential {
  id: string;
  consumerUsername: string;
  secret: Record<string, string>;
}

/** Issue a credential to `client`. Show-once: this is the only sight of it. */
export async function issueCredential(
  client: Session,
  type: 'keyauth' | 'basicauth' | 'jwt',
  applicationId?: string,
): Promise<IssuedCredential> {
  const body = await portal<{
    credential: { id: string };
    consumer_username: string;
    secret: Record<string, string>;
  }>('POST', '/api/credentials', {
    session: client,
    body: { credential_type: type, ...(applicationId ? { application_id: applicationId } : {}) },
  });
  return {
    id: body.credential.id,
    consumerUsername: body.consumer_username,
    secret: body.secret,
  };
}

/**
 * The `Authorization` (or `X-API-Key`) header a credential of each flavour
 * produces, as the client-facing documentation describes it.
 *
 * The JWT case is the one worth reading: Nexus issues the **signing secret**,
 * not a token. The client mints its own HS256 token with `sub` set to the
 * consumer username, which is what Edge's `jwt_auth` matches on. Doing that
 * here, with `node:crypto` and no library, is the point — it proves the
 * documented contract is sufficient to authenticate.
 */
export function authHeadersFor(
  credential: IssuedCredential,
  type: 'keyauth' | 'basicauth' | 'jwt',
): Record<string, string> {
  if (type === 'keyauth') {
    const key = credential.secret.key;
    if (!key) throw new Error('keyauth credential carried no key');
    return { 'X-API-Key': key };
  }
  if (type === 'basicauth') {
    // The consumer's username *is* the basic-auth username, and the portal
    // hands it back in the show-once payload rather than making the client
    // derive it.
    const { username, password } = credential.secret;
    if (!username || !password) throw new Error('basicauth credential was incomplete');
    const pair = Buffer.from(`${username}:${password}`).toString('base64');
    return { authorization: `Basic ${pair}` };
  }
  // `jwt_secret` signs the token and `jwt_key` is what goes in `sub`, which is
  // the claim Edge's `jwt_auth` matches the consumer on.
  const { jwt_secret: secret, jwt_key: subject } = credential.secret;
  if (!secret || !subject) throw new Error('jwt credential was incomplete');
  return { authorization: `Bearer ${signJwt(subject, secret)}` };
}

/**
 * The one header the catalog document's security says carries the gateway
 * credential, filled with the value {@link authHeadersFor} produced.
 *
 * Reads the root `security` of the document `GET /api/catalog/:slug/spec`
 * serves and the scheme it names, as an OpenAPI client (an importer, a code
 * generator) would: an `apiKey` header keeps its declared name, and `http`
 * `basic` / `bearer` use `Authorization` with that prefix. It throws when the
 * document names no single scheme, or one the issued credential cannot fill,
 * so a gateway call made with the result tests the document, not this helper.
 */
export function headersFromCatalogSecurity(
  document: unknown,
  issued: Record<string, string>,
): Record<string, string> {
  const doc = document as {
    security?: Record<string, unknown>[];
    components?: { securitySchemes?: Record<string, Record<string, unknown>> };
  };
  const names = Object.keys(doc.security?.[0] ?? {});
  if (doc.security?.length !== 1 || names.length !== 1) {
    throw new Error(
      `expected exactly one gateway requirement, got ${JSON.stringify(doc.security)}`,
    );
  }
  const scheme = doc.components?.securitySchemes?.[names[0]!];
  const valueOf = (header: string): string | undefined =>
    Object.entries(issued).find(([name]) => name.toLowerCase() === header.toLowerCase())?.[1];
  if (scheme?.type === 'apiKey' && scheme.in === 'header' && typeof scheme.name === 'string') {
    const value = valueOf(scheme.name);
    if (value === undefined) throw new Error(`the credential has no ${scheme.name} header`);
    return { [scheme.name]: value };
  }
  if (scheme?.type === 'http' && typeof scheme.scheme === 'string') {
    const prefix = scheme.scheme.toLowerCase() === 'basic' ? 'Basic ' : 'Bearer ';
    const value = valueOf('authorization');
    if (value === undefined || !value.startsWith(prefix)) {
      throw new Error(`the credential is not a ${prefix.trim()} Authorization header`);
    }
    return { authorization: value };
  }
  throw new Error(`unexpected gateway security scheme ${JSON.stringify(scheme)}`);
}

/** A minimal HS256 token — no dependency, so the contract is the only input. */
export function signJwt(subject: string, secret: string): string {
  const encode = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({ sub: subject, iat: now, exp: now + 300 });
  const body = `${head}.${payload}`;
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}
