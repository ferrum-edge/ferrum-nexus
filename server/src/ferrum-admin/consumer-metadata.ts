/**
 * Edge c764084b Consumer metadata PUT projection. Hidden types are omitted so
 * prepare_for_update restores them; exact secret placeholders restore keyauth
 * fields and canonicalize JWT/HMAC to their supported single secret field.
 * The caller must keep the original credential-complete row If-Match.
 */
import { edgeError } from '../lib/errors.js';
import type { EdgeConsumerReplacement, EdgeVerifiedConsumer } from './types.js';

const HMAC_PASSWORD_HASH = /^hmac_sha256:[0-9a-f]{64}$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

export function consumerMetadataCredentials(
  credentials: Record<string, unknown>,
): Record<string, Record<string, unknown>[]> {
  const basic = credentials.basicauth;
  if (basic !== undefined) {
    const entries = Array.isArray(basic) ? basic : [basic];
    if (
      !Array.isArray(basic) ||
      entries.length === 0 ||
      entries.some(
        (entry) =>
          typeof entry !== 'object' ||
          entry === null ||
          Array.isArray(entry) ||
          Object.keys(entry).length !== 1 ||
          !('password_hash' in entry) ||
          typeof entry.password_hash !== 'string' ||
          !HMAC_PASSWORD_HASH.test(entry.password_hash),
      )
    ) {
      throw edgeError('Stored Basic credentials cannot pass the Edge metadata update contract', {
        reason: 'consumer_metadata_unrepresentable',
        credential_type: 'basicauth',
      });
    }
  }
  const projected: Record<string, Record<string, unknown>[]> = {};
  for (const [type, value] of Object.entries(credentials)) {
    const entries = (Array.isArray(value) ? value : [value]).filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === 'object' && entry !== null && !Array.isArray(entry),
    );
    if (type === 'keyauth' || type === 'jwt' || type === 'hmac_auth') {
      if (entries.length > 0) {
        const field = type === 'keyauth' ? 'key' : 'secret';
        projected[type] = entries.map(() => ({ [field]: '[REDACTED]' }));
      }
    } else if (type === 'mtls_auth') {
      const visible = entries.flatMap((entry) => {
        const identity = entry.identity;
        return typeof identity === 'string' &&
          identity.trim() !== '' &&
          [...identity].length <= 4096 &&
          !CONTROL_CHARACTER.test(identity)
          ? [{ identity }]
          : [];
      });
      if (visible.length > 0) projected[type] = visible;
    }
  }
  // Edge restores omitted Basic/custom and an exact mTLS projection itself.
  // It validates the restored state; truly unrepresentable history must fail
  // there, never be dropped here to make the metadata write succeed.
  return projected;
}

/**
 * The whole-resource `PUT /consumers/{id}` body that replaces only a live
 * consumer's `acl_groups` (CLAUDE.md rule 13): every other writable field is
 * carried over from the credential-complete `verification()` row, so an ACL
 * change never resets an operator's labels or `custom_id`. Send it with that
 * snapshot's row tag.
 *
 * The mapped type lists every key of {@link EdgeConsumerReplacement}, so a
 * writable field added to the Edge consumer body fails to compile here until it
 * is preserved. Read-only fields (`namespace`, timestamps) are left out: Edge
 * rejects unknown keys on write.
 */
export function consumerWithAclGroups(
  live: EdgeVerifiedConsumer,
  aclGroups: string[],
): EdgeConsumerReplacement {
  const body: { [K in keyof Required<EdgeConsumerReplacement>]: EdgeConsumerReplacement[K] } = {
    id: live.id,
    labels: live.labels,
    username: live.username,
    custom_id: live.custom_id ?? null,
    credentials: live.credentials,
    acl_groups: aclGroups,
  };
  return body;
}
