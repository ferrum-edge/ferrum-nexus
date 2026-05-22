export type PolicySeverity = 'error' | 'warn';

export type PolicyRuleKind =
  | 'required_field'
  | 'string_length'
  | 'allowed_values'
  | 'tag_required'
  | 'tag_naming'
  | 'timeout_range'
  | 'body_size_max'
  | 'plugin_required'
  | 'operation_summary_required'
  | 'naming_regex';

export interface PolicyRule {
  id: string;
  description: string;
  severity: PolicySeverity;
  exceptionEligible: boolean;
  kind: PolicyRuleKind;
  params?: Record<string, unknown>;
}

export interface GovernancePolicy {
  version: number;
  updatedAt: string;
  updatedBy: string | null;
  rules: PolicyRule[];
}

export interface Violation {
  ruleId: string;
  severity: PolicySeverity;
  message: string;
  pointer: string;
  exceptionEligible: boolean;
}

export type PolicyExceptionStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface PolicyExceptionRequest {
  id: string;
  apiAssetId: string | null;
  providerId: string;
  pendingPublishId: string | null;
  violations: Violation[];
  justification: string;
  status: PolicyExceptionStatus;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewerNotes: string | null;
  expiresAt: string | null;
  createdAt: string;
}
