import {
  AUTH_PLUGIN_LABELS,
  AUTH_PLUGIN_TYPES,
  CREDENTIAL_TYPE_FOR_PLUGIN,
  type CredentialType,
} from '@ferrum-nexus/shared';

/**
 * Display labels for Edge credential types, derived from the auth-plugin
 * labels so the two never drift apart.
 */
export const CREDENTIAL_TYPE_LABELS: Readonly<Record<CredentialType, string>> =
  AUTH_PLUGIN_TYPES.reduce<Record<CredentialType, string>>(
    (accumulator, plugin) => {
      accumulator[CREDENTIAL_TYPE_FOR_PLUGIN[plugin]] = AUTH_PLUGIN_LABELS[plugin];
      return accumulator;
    },
    { keyauth: 'API key', basicauth: 'HTTP Basic', jwt: 'JWT' },
  );

/** Every credential type, in the same order as the auth plugins. */
export const CREDENTIAL_TYPES: readonly CredentialType[] = AUTH_PLUGIN_TYPES.map(
  (plugin) => CREDENTIAL_TYPE_FOR_PLUGIN[plugin],
);
