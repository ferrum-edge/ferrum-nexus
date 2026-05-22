import { v4 as uuid } from 'uuid';
import type { PolicyExceptionRequest } from '@ferrum-nexus/shared';
import type { NexusStore, PolicyExceptionRequestRow } from '../db/store.js';
import type { AuditActor, AuditService } from '../audit/service.js';
import type { EmailService } from '../email/service.js';
import type { PublishingService } from '../api-publishing/service.js';
import type { PolicyService } from './policy-service.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';

export interface PolicyExceptionService {
  requestException(opts: {
    providerId: string;
    pendingPublishId: string;
    justification: string;
    actor?: AuditActor | null;
  }): Promise<PolicyExceptionRequest>;
  approve(opts: {
    id: string;
    reviewerId: string;
    reviewerNotes?: string | null;
    expiresAt?: string | null;
    actor?: AuditActor | null;
  }): Promise<{ exception: PolicyExceptionRequest; assetId: string | null }>;
  deny(opts: {
    id: string;
    reviewerId: string;
    reviewerNotes?: string | null;
    actor?: AuditActor | null;
  }): Promise<PolicyExceptionRequest>;
  listPending(): Promise<PolicyExceptionRequest[]>;
  listForProvider(providerId: string): Promise<PolicyExceptionRequest[]>;
  listForAsset(assetId: string): Promise<PolicyExceptionRequest[]>;
}

export function createPolicyExceptionService(
  store: NexusStore,
  audit: AuditService,
  email: EmailService,
  policy: PolicyService,
  publishing: PublishingService,
): PolicyExceptionService {
  const toApi = (row: PolicyExceptionRequestRow): PolicyExceptionRequest => ({
    id: row.id,
    apiAssetId: row.api_asset_id,
    providerId: row.provider_id,
    pendingPublishId: row.pending_publish_id,
    violations: row.violations,
    justification: row.justification,
    status: row.status,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    reviewerNotes: row.reviewer_notes,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  });

  const notifyAdmins = async (row: PolicyExceptionRequestRow): Promise<void> => {
    const provider = await store.users.findById(row.provider_id);
    const { rows } = await store.users.listFiltered({ status: 'active', limit: 10_000 });
    for (const admin of rows) {
      const roles = await store.userRoles.forUser(admin.id);
      if (!roles.includes('super_admin')) continue;
      await email.enqueue({
        to: admin.email,
        templateKey: 'policy_exception_created',
        vars: {
          providerEmail: provider?.email ?? row.provider_id,
          reviewUrl: '/admin/policy',
        },
        idempotencyKey: `policy-exception:${row.id}:${admin.id}`,
      });
    }
  };

  return {
    async requestException({ providerId, pendingPublishId, justification, actor }) {
      const pending = await store.pendingPublishes.findById(pendingPublishId);
      if (!pending) throw notFound('Pending publish not found');
      if (pending.provider_id !== providerId) throw forbidden('Not the pending publish owner');
      const evaluation = await policy.evaluate(pending.raw_spec);
      if (evaluation.blocking.length === 0) {
        throw badRequest('no_policy_violations', 'Pending publish has no blocking policy violations');
      }
      const now = new Date().toISOString();
      const row = await store.policyExceptions.insert({
        id: uuid(),
        api_asset_id:
          typeof pending.publish_input.assetId === 'string' ? pending.publish_input.assetId : null,
        provider_id: providerId,
        pending_publish_id: pendingPublishId,
        violations: evaluation.blocking,
        justification,
        status: 'pending',
        reviewed_by: null,
        reviewed_at: null,
        reviewer_notes: null,
        expires_at: null,
        created_at: now,
      });
      await store.pendingPublishes.update(pendingPublishId, { exception_request_id: row.id });
      await notifyAdmins(row);
      await audit.record(null, {
        action: 'policy_exception.create',
        targetType: 'policy_exception',
        targetId: row.id,
        after: row,
        actor,
      });
      return toApi(row);
    },
    async approve({ id, reviewerId, reviewerNotes, expiresAt, actor }) {
      const row = await store.policyExceptions.findById(id);
      if (!row) throw notFound('Policy exception not found');
      if (row.status !== 'pending') throw badRequest('not_pending', 'Exception is not pending');
      if (row.violations.some((violation) => !violation.exceptionEligible)) {
        throw badRequest(
          'non_exception_eligible_violation',
          'One or more violations are not exception-eligible',
        );
      }
      const approved = await store.policyExceptions.update(id, {
        status: 'approved',
        reviewed_by: reviewerId,
        reviewed_at: new Date().toISOString(),
        reviewer_notes: reviewerNotes ?? null,
        expires_at: expiresAt ?? null,
      });
      let assetId: string | null = null;
      if (approved.pending_publish_id) {
        const asset = await publishing.publishStaged({
          pendingPublishId: approved.pending_publish_id,
          exception: approved,
          actor,
        });
        assetId = asset.id;
      }
      const provider = await store.users.findById(approved.provider_id);
      if (provider?.email) {
        await email.enqueue({
          to: provider.email,
          templateKey: 'policy_exception_approved',
          vars: { reviewerNotes: reviewerNotes ?? '', assetId: assetId ?? '' },
          idempotencyKey: `policy-exception-approved:${id}`,
        });
      }
      await audit.record(null, {
        action: 'policy_exception.approve',
        targetType: 'policy_exception',
        targetId: id,
        after: approved,
        actor,
      });
      return { exception: toApi(approved), assetId };
    },
    async deny({ id, reviewerId, reviewerNotes, actor }) {
      const row = await store.policyExceptions.findById(id);
      if (!row) throw notFound('Policy exception not found');
      if (row.status !== 'pending') throw badRequest('not_pending', 'Exception is not pending');
      const denied = await store.policyExceptions.update(id, {
        status: 'denied',
        reviewed_by: reviewerId,
        reviewed_at: new Date().toISOString(),
        reviewer_notes: reviewerNotes ?? null,
      });
      const provider = await store.users.findById(denied.provider_id);
      if (provider?.email) {
        await email.enqueue({
          to: provider.email,
          templateKey: 'policy_exception_denied',
          vars: { reviewerNotes: reviewerNotes ?? '' },
          idempotencyKey: `policy-exception-denied:${id}`,
        });
      }
      await audit.record(null, {
        action: 'policy_exception.deny',
        targetType: 'policy_exception',
        targetId: id,
        after: denied,
        actor,
      });
      return toApi(denied);
    },
    async listPending() {
      return (await store.policyExceptions.listPending()).map(toApi);
    },
    async listForProvider(providerId) {
      return (await store.policyExceptions.listForProvider(providerId)).map(toApi);
    },
    async listForAsset(assetId) {
      return (await store.policyExceptions.listForAsset(assetId)).map(toApi);
    },
  };
}
