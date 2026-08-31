/**
 * Gateway credentials — issue, rotate, revoke. Show-once, by construction.
 *
 * ## Show-once is enforced twice
 *
 * Nexus generates the secret, returns it in exactly one HTTP response, and
 * stores only a SHA-256 fingerprint and the last four characters. Even if that
 * discipline slipped, Edge would still hold the line: every ordinary Admin API
 * response redacts `keyauth.key` and `jwt.secret` to the literal `[REDACTED]`
 * and omits `basicauth` entirely (`ref-edge-admin.md` §4.5). There is no read
 * path back to the plaintext on either side.
 *
 * ## Credential shapes, and why they are not what a portal would guess
 *
 * | Nexus type  | Edge entry            | What the client actually sends |
 * |-------------|-----------------------|--------------------------------|
 * | `keyauth`   | `{ key }`             | `X-API-Key: <key>`             |
 * | `basicauth` | `{ password }`        | Basic `<consumer username>:<password>` |
 * | `jwt`       | `{ secret }`          | HS256 JWT with `sub` = consumer username |
 *
 * Two consequences fall out of Edge's schemas and are worth stating plainly:
 *
 * - **`basicauth` has no username field.** The entry accepts exactly one of
 *   `password` / `password_hash` and nothing else; the lookup key is the
 *   *consumer's* `username` (§5.2). So the username Nexus shows the user is
 *   `nexus-user-<id>`, not a per-credential name — inventing one would produce
 *   a credential that cannot authenticate.
 * - **`jwt` has no key/kid field.** The entry is exactly `{ secret }`, 32–4096
 *   chars, and `additionalProperties: false` rejects `algorithm`, `kid`, and
 *   friends. The consumer is located from the `jwt_auth` plugin's
 *   `consumer_claim_field` (default `sub`), matched against the consumer's
 *   `username`/`id`/`custom_id`. `ShowOnceSecret.jwt_key` therefore carries the
 *   consumer username — the value the client must put in `sub`.
 *
 * ## Locating an entry to delete: Nexus row order *is* the array index
 *
 * Edge gives credential entries **no id**, and reads redact the material, so
 * there is nothing on the wire to match a specific entry against. What is
 * stable is the ordering: `POST` appends, `DELETE /{type}/{index}` removes by
 * 0-based index, and Nexus writes one `credential_metadata` row per append. The
 * non-revoked rows for a `(consumer, type)` pair, oldest first, are therefore a
 * mirror of the Edge array, and a row's position in that list is its index.
 *
 * {@link resolveCredentialIndex} computes that position and cross-checks it
 * against the live array length before any destructive call; a mismatch (an
 * operator edited the consumer by hand) degrades to deleting the whole
 * credential type when only one row is live, and otherwise refuses rather than
 * deleting somebody else's key.
 */

import {
  CREDENTIAL_TYPE_FOR_PLUGIN,
  consumerUsernameForUser,
  roleAtLeast,
  type CredentialMetadata,
  type CredentialType,
  type IssueCredentialResponse,
  type Paginated,
  type RotateCredentialResponse,
  type ShowOnceSecret,
  type Uuid,
} from '@ferrum-nexus/shared';

import { AuditAction, type AuditService } from '../audit/service.js';
import type { NexusConfig } from '../config/index.js';
import type {
  CredentialFilter,
  CredentialRecord,
  ListOptions,
  NexusStore,
  UserRecord,
} from '../db/store.js';
import type { EmailService } from '../email/service.js';
import type { FerrumAdminClient } from '../ferrum-admin/index.js';
import type { EdgeCredentialEntry, EdgeCredentialMap } from '../ferrum-admin/types.js';
import type { NexusCrypto } from '../lib/crypto.js';
import { randomSecret, randomToken } from '../lib/crypto.js';
import { conflict, edgeError, forbidden, notFound, validationFailed } from '../lib/errors.js';
import type { NotificationsService } from '../notifications/service.js';
import type { ConsumerProvisioner } from './consumers.js';

/** Every credential type a Nexus user may hold, in UI order. */
export const CREDENTIAL_TYPES = [
  'keyauth',
  'basicauth',
  'jwt',
] as const satisfies readonly CredentialType[];

/** Statuses that still occupy a slot in the Edge credentials array. */
const LIVE_STATUSES = new Set(['active', 'retiring']);

/** Generated plaintext plus the Edge entry that carries it. */
interface GeneratedCredential {
  /** The value fingerprinted and reduced to `last4`. */
  material: string;
  entry: EdgeCredentialEntry;
  secret: ShowOnceSecret;
}

/** Input for {@link CredentialsService.issueForConsumer}. */
export interface IssueForConsumerInput {
  /** The account the credential row is attributed to. */
  user: UserRecord;
  /** Edge consumer the entry is appended to. */
  consumerId: string;
  /** That consumer's username — what a `basicauth` or `jwt` client must send. */
  consumerUsername: string;
  credentialType: CredentialType;
  label?: string | null;
  /** Skip the per-type cap (test consumers start from an empty consumer). */
  skipCap?: boolean;
}

/** Credential operations. */
export interface CredentialsService {
  /** Consumer provisioning, shared with the access service. */
  readonly provisioner: ConsumerProvisioner;
  /** The caller's credentials, or another user's when an admin asks. */
  list(
    actor: UserRecord,
    targetUserId?: Uuid,
    filter?: { status?: CredentialMetadata['status'] },
    options?: ListOptions,
  ): Promise<Paginated<CredentialRecord>>;
  /** Mint a credential on the caller's own consumer. Show-once. */
  issue(
    user: UserRecord,
    input: { credential_type: CredentialType; label?: string | null },
    ip?: string | null,
  ): Promise<IssueCredentialResponse>;
  /** Append-then-delete rotation of one credential. Show-once. */
  rotate(
    user: UserRecord,
    credentialId: Uuid,
    label?: string | null,
    ip?: string | null,
  ): Promise<RotateCredentialResponse>;
  /** Delete the entry from Edge and mark the row revoked. */
  revoke(user: UserRecord, credentialId: Uuid, ip?: string | null): Promise<void>;
  /** Append a credential to an arbitrary consumer — the test-consumer path. */
  issueForConsumer(
    input: IssueForConsumerInput,
  ): Promise<{ credential: CredentialRecord; secret: ShowOnceSecret }>;
}

/** Dependencies of {@link createCredentialsService}. */
export interface CredentialsServiceDeps {
  config: NexusConfig;
  store: NexusStore;
  edge: FerrumAdminClient;
  crypto: NexusCrypto;
  audit: AuditService;
  notifications: NotificationsService;
  email: EmailService;
  provisioner: ConsumerProvisioner;
}

/* ── Material generation ────────────────────────────────────────────────── */

/**
 * Generate the plaintext for one credential type.
 *
 * All three secrets are 32 bytes of `crypto.randomBytes` rendered base64url,
 * which clears Edge's 32-character minimum for `jwt` secrets with room to
 * spare and stays far below the 4096-character ceiling.
 */
export function generateCredential(
  type: CredentialType,
  consumerUsername: string,
): GeneratedCredential {
  switch (type) {
    case 'keyauth': {
      const key = randomSecret('nxs', 32);
      return { material: key, entry: { key }, secret: { type, key } };
    }
    case 'basicauth': {
      // The consumer's username *is* the basic-auth username (§5.2); the entry
      // itself accepts nothing but the password.
      const password = randomToken(32);
      return {
        material: password,
        entry: { password },
        secret: { type, username: consumerUsername, password },
      };
    }
    case 'jwt': {
      const secret = randomToken(32);
      return {
        material: secret,
        entry: { secret },
        // `jwt_key` is the value the client puts in the token's `sub` claim.
        secret: { type, jwt_secret: secret, jwt_key: consumerUsername },
      };
    }
    default: {
      // Exhaustive: `CredentialType` has exactly three members.
      throw validationFailed(`Unsupported credential type '${String(type)}'`);
    }
  }
}

/** Last four characters of a secret, for identifying it in the UI. */
function last4(secret: string): string {
  return secret.length <= 4 ? secret : secret.slice(-4);
}

/* ── Service ────────────────────────────────────────────────────────────── */

/** Build the credentials service. */
export function createCredentialsService(deps: CredentialsServiceDeps): CredentialsService {
  const { config, store, edge, crypto, audit, notifications, email, provisioner } = deps;
  const cap = config.edge.maxCredentialsPerType;

  /** Rows still occupying an Edge array slot, oldest first. */
  async function liveRows(consumerId: string, type: CredentialType): Promise<CredentialRecord[]> {
    const rows = await store.credentials.listByConsumer(consumerId, type);
    return rows
      .filter((row) => LIVE_STATUSES.has(row.status))
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  }

  /**
   * 0-based index of `target` inside the Edge credentials array.
   *
   * `edgeLength` is the array length read from a *fresh* `GET /consumers/{id}`
   * inside the same serialised block, so the two views cannot drift between the
   * check and the delete.
   */
  function resolveCredentialIndex(
    rows: CredentialRecord[],
    target: CredentialRecord,
    edgeLength: number,
  ): number | 'whole-type' {
    const index = rows.findIndex((row) => row.id === target.id);
    if (index === -1) return 'whole-type';
    if (rows.length === edgeLength) return index;
    // The mirror drifted (a hand-edited consumer). Removing the entire type is
    // safe only when this is the last credential Nexus knows about.
    if (rows.length === 1) return 'whole-type';
    throw edgeError(
      'The gateway credential list does not match the portal; ask an administrator to reconcile this consumer before rotating or revoking',
      { expected: rows.length, actual: edgeLength },
    );
  }

  /** Length of the Edge credentials array for one type (basicauth is never emitted). */
  function edgeArrayLength(
    credentials: EdgeCredentialMap | undefined,
    type: CredentialType,
    fallback: number,
  ): number {
    const entries = credentials?.[type];
    // `basicauth` is omitted from every read projection, so its length is
    // unknowable from a GET — trust the Nexus mirror for it.
    if (type === 'basicauth') return fallback;
    return Array.isArray(entries) ? entries.length : 0;
  }

  async function loadOwned(user: UserRecord, credentialId: Uuid): Promise<CredentialRecord> {
    const credential = await store.credentials.findById(credentialId);
    if (!credential) throw notFound('Credential', credentialId);
    if (credential.user_id !== user.id && !roleAtLeast(user.role, 'admin')) {
      // Not a 404: the caller is authenticated and the id is theirs to guess or
      // not, and a 403 is what the SPA needs to render a useful message.
      throw forbidden('This credential belongs to another account');
    }
    return credential;
  }

  async function appendCredential(input: {
    user: UserRecord;
    consumerId: string;
    consumerUsername: string;
    type: CredentialType;
    label: string | null;
    rotatedFromId?: Uuid | null;
  }): Promise<{ credential: CredentialRecord; secret: ShowOnceSecret }> {
    const generated = generateCredential(input.type, input.consumerUsername);
    await edge.consumers.addCredential(
      input.consumerId,
      input.type,
      generated.entry,
      input.user.id,
    );
    const credential = await store.credentials.create({
      user_id: input.user.id,
      ferrum_consumer_id: input.consumerId,
      credential_type: input.type,
      // Edge assigns credential entries no id of their own; the addressable
      // resource is the per-type collection, and position is tracked by row
      // order (see the module docblock).
      ferrum_credential_id: `${input.consumerId}/credentials/${input.type}`,
      fingerprint: crypto.fingerprint(generated.material),
      last4: last4(generated.material),
      label: input.label,
      status: 'active',
      rotated_from_id: input.rotatedFromId ?? null,
    });
    return { credential, secret: generated.secret };
  }

  async function issueForConsumer(
    input: IssueForConsumerInput,
  ): Promise<{ credential: CredentialRecord; secret: ShowOnceSecret }> {
    if (!(CREDENTIAL_TYPES as readonly string[]).includes(input.credentialType)) {
      throw validationFailed(`Unsupported credential type '${input.credentialType}'`);
    }
    return edge.serializePerKey(input.consumerId, async () => {
      if (input.skipCap !== true) {
        const rows = await liveRows(input.consumerId, input.credentialType);
        if (rows.length >= cap) {
          throw conflict(
            `You already hold ${rows.length} live ${input.credentialType} credentials (the gateway allows ${cap}); revoke or rotate one first`,
            { credential_type: input.credentialType, limit: cap },
          );
        }
      }
      return appendCredential({
        user: input.user,
        consumerId: input.consumerId,
        consumerUsername: input.consumerUsername,
        type: input.credentialType,
        label: input.label ?? null,
      });
    });
  }

  return {
    provisioner,
    issueForConsumer,

    async list(actor, targetUserId, filter = {}, options): Promise<Paginated<CredentialRecord>> {
      const userId = targetUserId ?? actor.id;
      if (userId !== actor.id && !roleAtLeast(actor.role, 'admin')) {
        throw forbidden('Only an administrator can list another account’s credentials');
      }
      const storeFilter: CredentialFilter = {
        user_id: userId,
        ...(filter.status !== undefined ? { status: filter.status } : {}),
      };
      return store.credentials.list(storeFilter, options);
    },

    async issue(user, input, ip = null): Promise<IssueCredentialResponse> {
      if (!(CREDENTIAL_TYPES as readonly string[]).includes(input.credential_type)) {
        throw validationFailed(`Unsupported credential type '${input.credential_type}'`);
      }
      const consumer = await provisioner.ensureConsumer(user);

      const { credential, secret } = await issueForConsumer({
        user,
        consumerId: consumer.ferrum_consumer_id,
        consumerUsername: consumer.ferrum_username,
        credentialType: input.credential_type,
        label: input.label ?? null,
      });

      await audit.record(
        { id: user.id, role: user.role },
        AuditAction.CREDENTIAL_ISSUE,
        { type: 'credential', id: credential.id },
        {
          credential_type: credential.credential_type,
          consumer_id: consumer.ferrum_consumer_id,
          last4: credential.last4,
        },
        ip,
      );

      return { credential, consumer_username: consumer.ferrum_username, secret };
    },

    async rotate(user, credentialId, label, ip = null): Promise<RotateCredentialResponse> {
      const target = await loadOwned(user, credentialId);
      if (target.status === 'revoked') {
        throw conflict('This credential has already been revoked');
      }
      const type = target.credential_type;
      const consumerId = target.ferrum_consumer_id;

      const result = await edge.serializePerKey(consumerId, async () => {
        const consumer = await edge.consumers.get(consumerId);
        if (!consumer) throw edgeError('The gateway consumer for this credential no longer exists');
        const rows = await liveRows(consumerId, type);
        const length = edgeArrayLength(consumer.credentials, type, rows.length);
        const position = resolveCredentialIndex(rows, target, length);

        // Append-then-delete keeps both secrets live across the hand-off. When
        // the array is already at the gateway cap there is no room to append,
        // so the old entry has to go first — briefly leaving the account with
        // no working credential of this type, which is unavoidable at the cap.
        const appendFirst = length < cap;

        if (!appendFirst) {
          await removeAt(consumerId, type, position, user.id);
        }
        const created = await appendCredential({
          user,
          consumerId,
          consumerUsername: consumer.username,
          type,
          label: label ?? target.label,
          rotatedFromId: target.id,
        });
        if (appendFirst) {
          // `POST` appends, so the old entry's index is unchanged by the append.
          await removeAt(consumerId, type, position, user.id);
        }

        const previous =
          (await store.credentials.update(target.id, { status: 'revoked' })) ?? target;
        return { created, previous };
      });

      await audit.record(
        { id: user.id, role: user.role },
        AuditAction.CREDENTIAL_ROTATE,
        { type: 'credential', id: result.created.credential.id },
        {
          credential_type: type,
          consumer_id: consumerId,
          rotated_from: target.id,
          previous_last4: target.last4,
        },
        ip,
      );

      const owner = target.user_id === user.id ? user : await store.users.findById(target.user_id);
      if (owner) {
        await notifications
          .notify(
            owner.id,
            'credential_rotated',
            'A gateway credential was rotated',
            `Your ${type} credential ending …${target.last4} was replaced.`,
            '/credentials',
          )
          .catch(() => undefined);
        await email
          .enqueue({
            to: owner.email,
            templateKey: 'credential_rotated',
            vars: {
              recipient_name: owner.display_name,
              recipient_email: owner.email,
              credential_label: result.created.credential.label ?? type,
              credential_last4: result.created.credential.last4,
              credentials_url: `${config.publicUrl}/credentials`,
            },
          })
          .catch(() => undefined);
      }

      return {
        credential: result.created.credential,
        previous: result.previous,
        consumer_username: consumerUsernameForUser(target.user_id),
        secret: result.created.secret,
      };
    },

    async revoke(user, credentialId, ip = null): Promise<void> {
      const target = await loadOwned(user, credentialId);
      if (target.status === 'revoked') return;
      const type = target.credential_type;
      const consumerId = target.ferrum_consumer_id;

      await edge.serializePerKey(consumerId, async () => {
        const consumer = await edge.consumers.get(consumerId);
        // A consumer deleted out from under us means the entry is already gone;
        // the row still has to be marked so the UI stops offering it.
        if (consumer) {
          const rows = await liveRows(consumerId, type);
          const length = edgeArrayLength(consumer.credentials, type, rows.length);
          await removeAt(consumerId, type, resolveCredentialIndex(rows, target, length), user.id);
        }
        await store.credentials.update(target.id, { status: 'revoked' });
      });

      await audit.record(
        { id: user.id, role: user.role },
        AuditAction.CREDENTIAL_REVOKE,
        { type: 'credential', id: target.id },
        { credential_type: type, consumer_id: consumerId, last4: target.last4 },
        ip,
      );
    },
  };

  /** Delete one entry by index, or the whole type when the index is unusable. */
  async function removeAt(
    consumerId: string,
    type: CredentialType,
    position: number | 'whole-type',
    subject: string,
  ): Promise<void> {
    if (position === 'whole-type') {
      await edge.consumers.deleteCredentialType(consumerId, type, subject);
      return;
    }
    await edge.consumers.deleteCredentialAt(consumerId, type, position, subject);
  }
}
