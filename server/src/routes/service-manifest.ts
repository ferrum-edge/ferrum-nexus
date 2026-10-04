import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { MANIFEST_BODY_LIMIT, type PreviewServiceManifestResponse } from '@ferrum-nexus/shared';
import type { ServiceManifestService } from '../service-manifest/service.js';
import { requireAuth, requireRole } from '../middleware/auth-plugin.js';
import { parseOrThrow } from '../middleware/error-handler.js';

export const serviceManifestRoutes: FastifyPluginAsync<{
  serviceManifest: ServiceManifestService;
}> = async (app, options) => {
  app.addHook('onRequest', requireRole('provider'));
  app.post(
    '/preview',
    {
      bodyLimit: MANIFEST_BODY_LIMIT,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request): Promise<PreviewServiceManifestResponse> => {
      const { user } = requireAuth(request);
      const input = parseOrThrow(
        z
          .object({
            namespace: z.string().min(1).max(128),
            manifest: z.unknown().refine((value) => value !== undefined),
          })
          .strict(),
        request.body,
      );
      return options.serviceManifest.preview(user, {
        namespace: input.namespace,
        manifest: input.manifest,
      });
    },
  );
};
