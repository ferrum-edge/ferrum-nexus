/**
 * `GET /api/branding` — the one unauthenticated read in the API.
 *
 * The SPA calls this before it has a session so the login page can render with
 * the right name, logo, colours and theme, and so it knows whether to mount a
 * CAPTCHA widget. Everything returned here is public by construction: the
 * CAPTCHA block carries the site key only, never the vendor secret, and
 * `bootstrap_required` says that the portal is empty without saying anything
 * about the token that guards it. The registration policy is here for the same
 * reason: the sign-up form has to know which roles it may offer before it has
 * a session, and both facts it carries are already observable by attempting a
 * registration.
 */

import type { FastifyPluginAsync } from 'fastify';

import { REGISTRABLE_ROLES, type BrandingResponse } from '@ferrum-nexus/shared';

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
    const policy = await auth.getRegistrationPolicy();
    return {
      ...branding,
      captcha: await captcha.getPublicConfig(),
      // Narrowed to the self-selectable roles: the register route only accepts
      // those, so an elevated role left in the stored policy is not something
      // the sign-up form could ever offer.
      registration: {
        open_registration: policy.open_registration,
        allowed_roles: REGISTRABLE_ROLES.filter((role) => policy.allowed_roles.includes(role)),
      },
      bootstrap_required: await auth.bootstrapRequired(),
    };
  });
};
