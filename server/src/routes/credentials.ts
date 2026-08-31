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

import { CREDENTIAL_TYPES, type CredentialsService } from '../credentials/service.js';
import { clientIp, requireAuth, requireAuthHook } from '../middleware/auth-plugin.js';
import { parseOrThrow } from '../middleware/error-handler.js';
import { idParamSchema, listOptions, listQuerySchema } from './common.js';

/** Services this route plugin needs. */
export interface CredentialsRoutesOptions {
  credentials: CredentialsService;
}

const listCredentialsQuery = listQuerySchema.extend({
  status: z.enum(['active', 'retiring', 'revoked']).optional(),
  /** Admin-only: inspect somebody else's credential metadata. */
  user_id: z.string().trim().min(1).max(64).optional(),
});

const issueBody = z.object({
  credential_type: z.enum(CREDENTIAL_TYPES),
  label: z.string().trim().max(120).nullish(),
});

const rotateBody = z.object({ label: z.string().trim().max(120).nullish() });

/** `/api/credentials` route plugin. */
export const credentialsRoutes: FastifyPluginAsync<CredentialsRoutesOptions> = async (
  app,
  options,
) => {
  const { credentials } = options;
  app.addHook('onRequest', requireAuthHook);

  app.get('/', async (request): Promise<ListCredentialsResponse> => {
    const { user } = requireAuth(request);
    const query = parseOrThrow(listCredentialsQuery, request.query);
    return credentials.list(
      user,
      query.user_id,
      { ...(query.status !== undefined ? { status: query.status } : {}) },
      listOptions(query),
    );
  });

  app.post('/', async (request, reply): Promise<IssueCredentialResponse> => {
    const { user } = requireAuth(request);
    const input = parseOrThrow(issueBody, request.body);
    const result = await credentials.issue(
      user,
      { credential_type: input.credential_type, label: input.label ?? null },
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
