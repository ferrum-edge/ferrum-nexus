import type { SsoErrorReason } from '@ferrum-nexus/shared';

/**
 * What to tell someone single sign-on sent back refused — on the sign-in page,
 * or on the profile page after an explicit link. The server reports a reason
 * from a closed set, never the provider's own text.
 */
export const SSO_ERROR_MESSAGES: Readonly<Record<SsoErrorReason, string>> = {
  sso_disabled: 'Single sign-on is not available for that provider.',
  provider_unavailable:
    'The identity provider could not be reached or is misconfigured. Try again, or contact an administrator.',
  invalid_state:
    'That sign-in attempt expired or did not start in this browser. Please start again.',
  idp_error: 'The identity provider did not complete the sign-in.',
  token_invalid: 'The identity provider’s answer could not be verified. Please try again.',
  email_required: 'The identity provider did not share an email address for your account.',
  email_domain_not_allowed: 'Your email domain is not allowed to sign in to this portal.',
  email_not_verified: 'The identity provider has not verified your email address.',
  account_exists:
    'An account with this email address already exists and could not be linked automatically. Sign in with your password and link single sign-on from your profile, or ask an administrator.',
  address_unproven:
    'Single sign-on can only be linked once this portal has confirmed your email address. Use Forgot password to reset your password, which confirms your address, then link again.',
  privileged_account:
    'An account that is, or that this provider would make, an administrator is never linked automatically. Sign in the way you usually do, then link single sign-on from your profile.',
  link_session_mismatch:
    'That link did not come back to the session that started it. Sign in and start the link again from your profile.',
  already_linked:
    'That identity is already linked to an account, or this account is already linked at that provider.',
  access_denied: 'Your account at the identity provider does not grant access to this portal.',
  account_disabled: 'This account has been disabled.',
  signup_disabled: 'No portal account is linked to this identity, and sign-up through it is off.',
  server_error: 'Single sign-on failed. Please try again.',
};
