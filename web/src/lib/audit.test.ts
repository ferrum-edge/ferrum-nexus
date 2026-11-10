import { describe, expect, it } from 'vitest';
import { auditTone } from './audit';

describe('auditTone', () => {
  it('colours constructive, destructive and housekeeping actions', () => {
    expect(auditTone('access.approve')).toBe('success');
    expect(auditTone('api.publish')).toBe('success');
    expect(auditTone('gateway.consumer_repair')).toBe('success');
    expect(auditTone('api.gateway_restore')).toBe('success');
    expect(auditTone('access.revoke')).toBe('danger');
    expect(auditTone('god.delete_api')).toBe('danger');
    expect(auditTone('auth.login')).toBe('neutral');
    expect(auditTone('message.send')).toBe('neutral');
  });

  it('lets a rollback, failure or pending repair outrank the verb it qualifies', () => {
    expect(auditTone('access.approve_rollback')).toBe('warning');
    expect(auditTone('api.publish_rollback')).toBe('warning');
    expect(auditTone('credential.revoke_rollback')).toBe('warning');
    expect(auditTone('api.gateway_restore_failed')).toBe('warning');
    expect(auditTone('api.gateway_repair_required')).toBe('warning');
    expect(auditTone('credential.recovery_stalled')).toBe('warning');
  });

  it('lets a destructive verb outrank a constructive one', () => {
    expect(auditTone('god.revoke_grant')).toBe('danger');
    expect(auditTone('access.revoke_complete')).toBe('danger');
  });

  it('matches whole words, not substrings', () => {
    expect(auditTone('user.address_release')).toBe('neutral');
    expect(auditTone('api.spec_revision_start')).toBe('neutral');
  });
});
