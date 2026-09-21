/**
 * `/api/credentials` — show-once gateway credentials.
 *
 * `POST /` and `POST /:id/rotate` are the **only two responses in the whole API
 * that carry plaintext credential material**, and each carries it exactly once.
 * Nothing on this route can read a secret back: the store holds a fingerprint
 * and the last four characters, and Edge redacts everything on read.
 *
 * Both of those responses are already `cache-control: no-store` via the global
 * `/api` hook, which is what keeps a show-once payload out of a shared cache.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import type {
  DeleteCredentialResponse,
  IssueCredentialResponse,
  ListCredentialsResponse,
  RotateCredentialResponse,
} from '@ferrum-nexus/shared';

import type { ApplicationsService } from '../applications/service.js';
import { CREDENTIAL_TYPES, type CredentialsService } from '../credentials/service.js';
import { clientIp, requireAuth, requireAuthHook } from '../middleware/auth-plugin.js';
import { parseOrThrow } from '../middleware/error-handler.js';
import { idParamSchema, listOptions, listQuerySchema } from './common.js';

/** Services this route plugin needs. */
export interface CredentialsRoutesOptions {
  credentials: CredentialsService;
  /** Resolves and authorizes the application a credential is issued as. */
  applications: ApplicationsService;
}

const listCredentialsQuery = listQuerySchema.extend({
  status: z.enum(['active', 'retiring', 'revoked']).optional(),
  /** Admin-only: inspect somebody else's credential metadata. */
  user_id: z.string().trim().min(1).max(64).optional(),
  /**
   * Narrow to one identity. An application id lists that application's
   * credentials; the literal `account` lists the ones that belong to the
   * account itself.
   *
   * A sentinel rather than an absent parameter because "the account's own" and
   * "all of them" are different questions, and a query string has no `null`.
   */
  application_id: z.string().trim().min(1).max(64).optional(),
});

/** The `application_id` query sentinel meaning "the account's own identity". */
const ACCOUNT_SCOPE = 'account';

const issueBody = z.object({
  credential_type: z.enum(CREDENTIAL_TYPES),
  label: z.string().trim().max(120).nullish(),
  /** One of the caller's applications, or absent for the account itself. */
  application_id: z.string().trim().min(1).max(64).nullish(),
});

const rotateBody = z.object({ label: z.string().trim().max(120).nullish() });

/** `/api/credentials` route plugin. */
export const credentialsRoutes: FastifyPluginAsync<CredentialsRoutesOptions> = async (
  app,
  options,
) => {
  const { credentials, applications } = options;
  app.addHook('onRequest', requireAuthHook);

  app.get('/', async (request): Promise<ListCredentialsResponse> => {
    const { user } = requireAuth(request);
    const query = parseOrThrow(listCredentialsQuery, request.query);
    return credentials.list(
      user,
      query.user_id,
      {
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.application_id === undefined
          ? {}
          : {
              application_id: query.application_id === ACCOUNT_SCOPE ? null : query.application_id,
            }),
      },
      listOptions(query),
    );
  });

  app.post('/', async (request, reply): Promise<IssueCredentialResponse> => {
    const { user } = requireAuth(request);
    const input = parseOrThrow(issueBody, request.body);
    // Resolved before the gateway is touched: this is what checks the caller
    // owns the application and that it is active. `null` is the account's own
    // identity, which is what an omitted field means and what every credential
    // issued before applications existed uses.
    const application = await applications.resolveForActor(user, input.application_id ?? null);
    const result = await credentials.issue(
      user,
      {
        credential_type: input.credential_type,
        label: input.label ?? null,
        application_id: application?.id ?? null,
      },
      clientIp(request),
    );
    reply.status(201);
    return result;
  });

  app.post('/:id/rotate', async (request): Promise<RotateCredentialResponse> => {
    const { user } = requireAuth(request);
    const { id } = parseOrThrow(idParamSchema, request.params);
    const body = parseOrThrow(rotateBody, request.body ?? {});
    return credentials.rotate(user, id, body.label ?? null, clientIp(request));
  });

  app.delete('/:id', async (request): Promise<DeleteCredentialResponse> => {
    const { user } = requireAuth(request);
    const { id } = parseOrThrow(idParamSchema, request.params);
    await credentials.revoke(user, id, clientIp(request));
    return { ok: true };
  });
};
