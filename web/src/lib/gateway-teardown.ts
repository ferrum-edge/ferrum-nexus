/**
 * What an administrator is told when disabling an account leaves its gateway
 * revocation `pending`: the portal account is off, but its API credentials
 * still work on the gateway until the durable teardown job lands.
 */
export const GATEWAY_REVOCATION_PENDING =
  'Its gateway credentials keep working until the gateway accepts the revocation, which is retried automatically. Follow it, or retry it, from Users.';
