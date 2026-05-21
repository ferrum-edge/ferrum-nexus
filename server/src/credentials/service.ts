/**
 * Credentials lifecycle.
 *
 * Each Nexus user has at most one Ferrum consumer per namespace. Credentials
 * live on the consumer (multiple per type for rotation). Nexus stores only
 * fingerprints + display metadata — never plaintext keys, HMAC secrets, basic
 * auth passwords, or private keys.
 *
 * Rotation flow:
 *   1. Generate (or accept) new credential material.
 *   2. Append it to the Edge consumer.
 *   3. Return the new secret to the user (show once).
 *   4. Mark previous credentials of the same type as `pending_removal`.
 *   5. After the configured grace period, the user can finalize and delete
 *      the older credential entries.
 */

import { randomBytes } from 'node:crypto';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import type { NexusStore } from '../db/store.js';
import type { ResolvedConfig } from '../config/index.js';
import type { FerrumAdminClient } from '../ferrum-admin/client.js';
import type { AuditService } from '../audit/service.js';
import type { NotificationService } from '../notifications/service.js';
import type { EmailService } from '../email/service.js';
import { badRequest, notFound } from '../lib/errors.js';
import { fingerprint, last4 } from '../lib/crypto.js';
import { aclGroupForApi, type CredentialType } from '@ferrum-nexus/shared';
import type { CredentialMetadata } from '@ferrum-nexus/shared';

export const CredentialCreateInput = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('keyauth'),
    label: z.string().min(1).max(64).default('Default'),
  }),
  z.object({
    type: z.literal('basicauth'),
    label: z.string().min(1).max(64).default('Default'),
    username: z.string().min(3).max(64).optional(),
  }),
  z.object({
    type: z.literal('jwt'),
    label: z.string().min(1).max(64).default('Default'),
    data: z.record(z.unknown()),
  }),
  z.object({
    type: z.literal('hmac_auth'),
    label: z.string().min(1).max(64).default('Default'),
  }),
  z.object({
    type: z.literal('mtls_auth'),
    label: z.string().min(1).max(64).default('Default'),
    cert: z.string().min(1),
  }),
]);
export type CredentialCreateInput = z.infer<typeof CredentialCreateInput>;

export interface CredentialIssueResult {
  metadata: CredentialMetadata;
  /** The credential value to show to the user exactly once. */
  secret?: {
    type: CredentialType;
    /** Field name to display (key, password, hmacSecret, etc). */
    field: string;
    value: string;
  };
}

export interface CredentialsService {
  ensureConsumerForUser(opts: {
    userId: string;
    email: string;
    name: string | null;
    namespace?: string;
  }): Promise<string>;
  listForUser(userId: string): Promise<CredentialMetadata[]>;
  issue(opts: {
    userId: string;
    input: CredentialCreateInput;
    namespace?: string;
  }): Promise<CredentialIssueResult>;
  rotate(opts: {
    userId: string;
    credentialId: string;
    /**
     * Replacement payload for credential types that cannot be auto-generated
     * (currently JWT and mTLS). Ignored for keyauth/basicauth/hmac_auth
     * because Nexus generates the new secret itself.
     */
    replacement?: CredentialCreateInput;
  }): Promise<CredentialIssueResult>;
  finalize(opts: { userId: string; credentialId: string }): Promise<void>;
  syncAclGroupsForGrant(opts: {
    consumerId: string;
    apiAssetId: string;
    add: boolean;
  }): Promise<void>;
}

export function createCredentialsService(
  config: ResolvedConfig,
  store: NexusStore,
  ferrum: FerrumAdminClient,
  audit: AuditService,
  notifications: NotificationService,
  email: EmailService,
): CredentialsService {
  const toMeta = (row: {
    id: string;
    consumer_id: string;
    type: CredentialType;
    label: string;
    fingerprint: string;
    last4: string | null;
    ferrum_credential_index: number;
    status: 'active' | 'pending_removal' | 'expired';
    created_at: string;
    rotated_at: string | null;
    expires_at: string | null;
  }): CredentialMetadata => ({
    id: row.id,
    consumerId: row.consumer_id,
    type: row.type,
    label: row.label,
    fingerprint: row.fingerprint,
    last4: row.last4,
    ferrumCredentialIndex: row.ferrum_credential_index,
    status: row.status,
    createdAt: row.created_at,
    rotatedAt: row.rotated_at,
    expiresAt: row.expires_at,
  });

  const ensureConsumerForUser: CredentialsService['ensureConsumerForUser'] = async ({
    userId,
    email: userEmail,
    name,
    namespace,
  }) => {
    const ns = namespace ?? config.ferrum.defaultNamespace;
    const existing = await store.consumers.findByUserNamespace(userId, ns);
    if (existing) return existing.id;
    const username = `${(name ?? userEmail)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .slice(0, 40)}-${userId.slice(0, 8)}`;
    const created = await ferrum.createConsumer({ username, acl_groups: [], namespace: ns });
    const row = await store.consumers.insert({
      id: uuid(),
      user_id: userId,
      organization_id: null,
      namespace: ns,
      ferrum_consumer_id: created.consumer_id,
      username: created.username,
      status: 'active',
      acl_groups: [],
      created_at: new Date().toISOString(),
    });
    await audit.record(null, {
      action: 'consumer.create',
      targetType: 'ferrum_consumer',
      targetId: row.id,
      after: { namespace: ns, username, ferrumId: created.consumer_id },
    });
    return row.id;
  };

  const listForUser: CredentialsService['listForUser'] = async (userId) => {
    const consumers = await store.consumers.listForUser(userId);
    const all: CredentialMetadata[] = [];
    for (const consumer of consumers) {
      const rows = await store.credentials.listForConsumer(consumer.id);
      all.push(...rows.map(toMeta));
    }
    return all;
  };

  const issueInternal = async (
    consumerId: string,
    input: CredentialCreateInput,
    namespace: string,
    forUserEmail: string,
    forUserName: string | null,
    isRotation: boolean,
  ): Promise<CredentialIssueResult> => {
    const consumer = await store.consumers.findById(consumerId);
    if (!consumer) throw notFound('Ferrum consumer not found');

    let data: Record<string, unknown>;
    let secret: CredentialIssueResult['secret'];

    switch (input.type) {
      case 'keyauth': {
        const key = randomBytes(24).toString('base64url');
        data = { key };
        secret = { type: 'keyauth', field: 'key', value: key };
        break;
      }
      case 'basicauth': {
        const username = input.username ?? `${consumer.username}-${randomBytes(3).toString('hex')}`;
        const password = randomBytes(18).toString('base64url');
        data = { username, password };
        secret = { type: 'basicauth', field: 'password', value: password };
        break;
      }
      case 'jwt': {
        data = input.data;
        if (typeof data.secret === 'string') {
          secret = { type: 'jwt', field: 'secret', value: data.secret as string };
        }
        break;
      }
      case 'hmac_auth': {
        const username = `${consumer.username}-${randomBytes(3).toString('hex')}`;
        const sharedSecret = randomBytes(32).toString('base64url');
        data = { username, secret: sharedSecret };
        secret = { type: 'hmac_auth', field: 'secret', value: sharedSecret };
        break;
      }
      case 'mtls_auth': {
        data = { cert: input.cert };
        break;
      }
    }

    const appended = await ferrum.appendCredential(
      consumer.ferrum_consumer_id,
      { type: input.type, data },
      namespace,
    );

    const fp = fingerprint(
      input.type === 'mtls_auth' ? (data.cert as string) : JSON.stringify(data),
    );
    const visible = secret?.value ?? null;
    const row = await store.credentials.insert({
      id: uuid(),
      consumer_id: consumerId,
      type: input.type,
      label: input.label,
      fingerprint: fp,
      last4: visible ? last4(visible) : null,
      ferrum_credential_index: appended.index,
      status: 'active',
      created_at: new Date().toISOString(),
      rotated_at: null,
      expires_at: null,
    });

    if (isRotation) {
      const existing = await store.credentials.listForConsumer(consumerId);
      for (const cred of existing) {
        if (cred.id === row.id) continue;
        if (cred.type !== input.type) continue;
        if (cred.status === 'active') {
          await store.credentials.updateStatus(cred.id, 'pending_removal');
        }
      }
    }

    await audit.record(null, {
      action: isRotation ? 'credential.rotate' : 'credential.create',
      targetType: 'credential',
      targetId: row.id,
      after: { type: input.type, label: input.label, consumerId },
    });
    await notifications.push({
      recipientId: consumer.user_id!,
      type: isRotation ? 'credential_rotation_completed' : 'credential_created',
      payload: { credentialId: row.id, type: input.type, label: input.label },
    });
    await email.enqueue({
      to: forUserEmail,
      templateKey: isRotation ? 'credential_rotation_completed' : 'credential_created',
      vars: { name: forUserName ?? forUserEmail, credentialType: input.type, label: input.label },
    });

    return { metadata: toMeta(row), secret };
  };

  const issue: CredentialsService['issue'] = async ({ userId, input, namespace }) => {
    const user = await store.users.findById(userId);
    if (!user) throw notFound('User not found');
    const consumerId = await ensureConsumerForUser({
      userId,
      email: user.email,
      name: user.name,
      namespace,
    });
    const consumer = await store.consumers.findById(consumerId);
    return issueInternal(consumerId, input, consumer!.namespace, user.email, user.name, false);
  };

  const rotate: CredentialsService['rotate'] = async ({ userId, credentialId, replacement }) => {
    const cred = await store.credentials.findById(credentialId);
    if (!cred) throw notFound('Credential not found');
    const consumer = await store.consumers.findById(cred.consumer_id);
    if (!consumer || consumer.user_id !== userId) {
      throw notFound('Credential not found');
    }
    const user = await store.users.findById(userId);
    if (!user) throw notFound('User not found');
    const rotationInput: CredentialCreateInput = (() => {
      switch (cred.type) {
        case 'keyauth':
          return { type: 'keyauth', label: cred.label } as const;
        case 'basicauth':
          return { type: 'basicauth', label: cred.label } as const;
        case 'hmac_auth':
          return { type: 'hmac_auth', label: cred.label } as const;
        case 'jwt':
          // JWT secrets can't be auto-generated — the caller must supply a
          // replacement payload (new key material + claims). With the
          // replacement the rotation runs the standard append-then-mark-old
          // flow, giving JWT users a way to revoke a leaked signing key
          // without a manual delete-and-recreate dance.
          if (!replacement || replacement.type !== 'jwt') {
            throw badRequest(
              'replacement_required',
              'Rotating a JWT credential requires providing a new JWT payload in `replacement`.',
            );
          }
          return { ...replacement, label: replacement.label ?? cred.label };
        case 'mtls_auth':
          if (!replacement || replacement.type !== 'mtls_auth') {
            throw badRequest(
              'replacement_required',
              'Rotating an mTLS credential requires providing a new certificate in `replacement`.',
            );
          }
          return { ...replacement, label: replacement.label ?? cred.label };
      }
    })();
    return issueInternal(consumer.id, rotationInput, consumer.namespace, user.email, user.name, true);
  };

  const finalize: CredentialsService['finalize'] = async ({ userId, credentialId }) => {
    const cred = await store.credentials.findById(credentialId);
    if (!cred) throw notFound('Credential not found');
    const consumer = await store.consumers.findById(cred.consumer_id);
    if (!consumer || consumer.user_id !== userId) throw notFound('Credential not found');
    if (cred.status === 'active') {
      throw badRequest('still_active', 'Cannot delete an active credential. Rotate first.');
    }
    // Delete on Edge first. If Edge already returned 404 (already gone), the
    // wrapper resolves to null — we treat that as success so this endpoint is
    // safely retryable after a partial failure. Only after Edge confirms
    // removal do we drop the local row, so an Edge error leaves the local
    // pointer intact and the user can retry.
    await ferrum.deleteCredential(
      consumer.ferrum_consumer_id,
      cred.type,
      cred.ferrum_credential_index,
      consumer.namespace,
    );
    await store.credentials.delete(cred.id);
    await audit.record(null, {
      action: 'credential.finalize',
      targetType: 'credential',
      targetId: credentialId,
    });
  };

  // Reconcile a single ACL membership on Edge then mirror it locally. We call
  // Edge first because Edge is the system of record for authorization; if the
  // Edge call fails we throw and leave both sides unchanged. If Edge succeeds
  // but the local mirror fails, we try to revert Edge to the previous state so
  // we never leave Edge ahead of Nexus (which would silently grant access
  // without a corresponding Nexus grant record).
  const syncAclGroupsForGrant: CredentialsService['syncAclGroupsForGrant'] = async ({
    consumerId,
    apiAssetId,
    add,
  }) => {
    const consumer = await store.consumers.findById(consumerId);
    if (!consumer) throw notFound('Ferrum consumer not found');
    const previous = [...consumer.acl_groups];
    const group = aclGroupForApi(apiAssetId);
    const groups = new Set(previous);
    if (add) groups.add(group);
    else groups.delete(group);
    const next = [...groups];
    await ferrum.updateConsumer(
      consumer.ferrum_consumer_id,
      { acl_groups: next },
      consumer.namespace,
    );
    try {
      await store.consumers.updateAclGroups(consumer.id, next);
    } catch (err) {
      // Best-effort revert; if this also fails the drift sync job will catch
      // the divergence on its next pass.
      await ferrum
        .updateConsumer(consumer.ferrum_consumer_id, { acl_groups: previous }, consumer.namespace)
        .catch(() => undefined);
      throw err;
    }
  };

  return {
    ensureConsumerForUser,
    listForUser,
    issue,
    rotate,
    finalize,
    syncAclGroupsForGrant,
  };
}
