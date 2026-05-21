import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/session.js';
import type { AccessRequestsService } from '../access-requests/service.js';
import type { GrantsService } from '../grants/service.js';
import type { CredentialsService, CredentialCreateInput } from '../credentials/service.js';
import { CredentialCreateInput as CredentialInputSchema } from '../credentials/service.js';

export async function registerClientRoutes(
  app: FastifyInstance,
  opts: {
    accessRequests: AccessRequestsService;
    grants: GrantsService;
    credentials: CredentialsService;
  },
): Promise<void> {
  const { accessRequests, grants, credentials } = opts;

  app.get('/api/client/requests', async (req, reply) => {
    const user = requireAuth(req);
    const requests = await accessRequests.listForClient(user.id);
    reply.send({ requests });
  });

  app.get('/api/client/access', async (req, reply) => {
    const user = requireAuth(req);
    const items = await grants.listForClient(user.id);
    reply.send({ grants: items });
  });

  app.get('/api/client/credentials', async (req, reply) => {
    const user = requireAuth(req);
    const items = await credentials.listForUser(user.id);
    reply.send({ credentials: items });
  });

  app.post('/api/client/credentials', async (req, reply) => {
    const user = requireAuth(req);
    const input = CredentialInputSchema.parse(req.body) as CredentialCreateInput;
    const result = await credentials.issue({ userId: user.id, input });
    reply.status(201).send({ credential: result.metadata, secret: result.secret });
  });

  app.post('/api/client/credentials/:id/rotate', async (req, reply) => {
    const user = requireAuth(req);
    const { id } = req.params as { id: string };
    // Body is optional. JWT/mTLS rotations include a `replacement` of the same
    // type as the existing credential; auto-rotatable types ignore it.
    const parsed = z
      .object({ replacement: CredentialInputSchema.optional() })
      .safeParse(req.body ?? {});
    const replacement = parsed.success ? parsed.data.replacement : undefined;
    const result = await credentials.rotate({
      userId: user.id,
      credentialId: id,
      replacement,
    });
    reply.send({ credential: result.metadata, secret: result.secret });
  });

  app.post('/api/client/credentials/:id/finalize', async (req, reply) => {
    const user = requireAuth(req);
    const { id } = req.params as { id: string };
    await credentials.finalize({ userId: user.id, credentialId: id });
    reply.status(204).send();
  });
}
