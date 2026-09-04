/**
 * `GET /api/branding` — the one unauthenticated read in the API.
 *
 * The SPA calls this before it has a session so the login page can render with
 * the right name, logo, colours and theme, and so it knows whether to mount a
 * CAPTCHA widget. Everything returned here is public by construction: the
 * CAPTCHA block carries the site key only, never the vendor secret, and
 * `bootstrap_required` says that the portal is empty without saying anything
 * about the token that guards it.
 */

import type { FastifyPluginAsync } from 'fastify';

import type { BrandingResponse } from '@ferrum-nexus/shared';

import type { SettingsService } from '../admin/settings-service.js';
import type { CaptchaService } from '../auth/captcha.js';
import type { AuthService } from '../auth/service.js';

/** Services this route plugin needs. */
export interface BrandingRoutesOptions {
  settings: SettingsService;
  captcha: CaptchaService;
  auth: AuthService;
}

/** `/api/branding` route plugin (public). */
export const brandingRoutes: FastifyPluginAsync<BrandingRoutesOptions> = async (app, options) => {
  const { settings, captcha, auth } = options;

  app.get('/', async (): Promise<BrandingResponse> => {
    const branding = await settings.getBranding();
    return {
      ...branding,
      captcha: await captcha.getPublicConfig(),
      bootstrap_required: await auth.bootstrapRequired(),
    };
  });
};
