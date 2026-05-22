import type { GovernancePolicy, PolicyRule, Violation } from '@ferrum-nexus/shared';
import { extractKeyFacts } from '@ferrum-nexus/shared';
import type { NexusStore, PolicyExceptionRequestRow } from '../db/store.js';
import type { AuditActor, AuditService } from '../audit/service.js';
import { badRequest } from '../lib/errors.js';
import { parseSpec } from '../api-publishing/oas.js';

const POLICY_KEY = 'governance_policy';

export interface EvaluationResult {
  violations: Violation[];
  blocking: Violation[];
}

export interface PolicyService {
  get(): Promise<GovernancePolicy>;
  set(policy: Pick<GovernancePolicy, 'rules'>, actor?: AuditActor | null): Promise<GovernancePolicy>;
  evaluate(rawSpec: string): Promise<EvaluationResult>;
  evaluateWithException(
    rawSpec: string,
    exception: PolicyExceptionRequestRow | null,
  ): Promise<EvaluationResult>;
}

export function createPolicyService(store: NexusStore, audit: AuditService): PolicyService {
  const get = async (): Promise<GovernancePolicy> =>
    (await store.settings.get<GovernancePolicy>(POLICY_KEY)) ?? {
      version: 0,
      updatedAt: new Date(0).toISOString(),
      updatedBy: null,
      rules: [],
    };

  const evaluateRules = async (rawSpec: string): Promise<Violation[]> => {
    const policy = await get();
    const spec = parseSpec(rawSpec);
    const violations: Violation[] = [];
    for (const rule of policy.rules) {
      const violation = evaluateRule(rule, spec);
      if (violation) violations.push(violation);
    }
    return violations;
  };

  return {
    get,
    async set(input, actor) {
      const current = await get();
      const next: GovernancePolicy = {
        version: current.version + 1,
        updatedAt: new Date().toISOString(),
        updatedBy: actor?.id ?? null,
        rules: input.rules,
      };
      await store.settings.set(POLICY_KEY, next);
      await audit.record(null, {
        action: 'policy.update',
        targetType: 'governance_policy',
        targetId: String(next.version),
        before: current,
        after: next,
        actor,
      });
      return next;
    },
    async evaluate(rawSpec) {
      const violations = await evaluateRules(rawSpec);
      return { violations, blocking: violations.filter((v) => v.severity === 'error') };
    },
    async evaluateWithException(rawSpec, exception) {
      const violations = await evaluateRules(rawSpec);
      const exemptRuleIds =
        exception?.status === 'approved' &&
        (!exception.expires_at || new Date(exception.expires_at).getTime() > Date.now())
          ? new Set(exception.violations.filter((v) => v.exceptionEligible).map((v) => v.ruleId))
          : new Set<string>();
      const remaining = violations.filter((v) => !exemptRuleIds.has(v.ruleId));
      return { violations: remaining, blocking: remaining.filter((v) => v.severity === 'error') };
    },
  };
}

function evaluateRule(rule: PolicyRule, spec: Record<string, unknown>): Violation | null {
  const params = rule.params ?? {};
  const fail = (message: string, pointer: string): Violation => ({
    ruleId: rule.id,
    severity: rule.severity,
    message,
    pointer,
    exceptionEligible: rule.exceptionEligible,
  });

  switch (rule.kind) {
    case 'required_field': {
      const path = stringParam(params.path, 'path');
      return getByPath(spec, path).exists ? null : fail(`${path} is required`, pointerFor(path));
    }
    case 'string_length': {
      const path = stringParam(params.path, 'path');
      const found = getByPath(spec, path);
      const value = typeof found.value === 'string' ? found.value : '';
      const min = numberParam(params.min, 0);
      const max = numberParam(params.max, Number.POSITIVE_INFINITY);
      return value.length >= min && value.length <= max
        ? null
        : fail(`${path} must be between ${min} and ${max} characters`, pointerFor(path));
    }
    case 'allowed_values': {
      const path = stringParam(params.path, 'path');
      const values = arrayParam(params.values, 'values');
      const found = getByPath(spec, path);
      return values.includes(found.value)
        ? null
        : fail(`${path} must be one of ${values.join(', ')}`, pointerFor(path));
    }
    case 'tag_required': {
      const tag = stringParam(params.tag, 'tag');
      const tags = topLevelTags(spec);
      return tags.includes(tag) ? null : fail(`Tag ${tag} is required`, '/tags');
    }
    case 'tag_naming': {
      const regex = regexParam(params.regex, 'regex');
      const badTag = topLevelTags(spec).find((tag) => !regex.test(tag));
      return badTag ? fail(`Tag ${badTag} does not match ${regex.source}`, '/tags') : null;
    }
    case 'timeout_range': {
      const kind = stringParam(params.kind, 'kind');
      const min = numberParam(params.min, 0);
      const max = numberParam(params.max, Number.POSITIVE_INFINITY);
      const facts = extractKeyFacts(spec);
      const value =
        kind === 'connect'
          ? facts.timeoutConnectMs
          : kind === 'write'
            ? facts.timeoutWriteMs
            : facts.timeoutReadMs;
      return value != null && value >= min && value <= max
        ? null
        : fail(`${kind} timeout must be between ${min} and ${max} ms`, '/x-ferrum-proxy/timeouts');
    }
    case 'body_size_max': {
      const max = numberParam(params.max_bytes, Number.POSITIVE_INFINITY);
      const facts = extractKeyFacts(spec);
      return facts.bodySizeLimitBytes != null && facts.bodySizeLimitBytes <= max
        ? null
        : fail(`Body size limit must be at most ${max} bytes`, '/x-ferrum-proxy/body_size_limit_bytes');
    }
    case 'plugin_required': {
      const name = stringParam(params.name, 'name');
      return plugins(spec).some((plugin) => plugin.name === name)
        ? null
        : fail(`Plugin ${name} is required`, '/x-ferrum-proxy/plugins');
    }
    case 'operation_summary_required': {
      return missingOperationSummary(spec) == null
        ? null
        : fail('Each operation must define summary', missingOperationSummary(spec) ?? '/paths');
    }
    case 'naming_regex': {
      const path = stringParam(params.path, 'path');
      const regex = regexParam(params.regex, 'regex');
      const found = getByPath(spec, path);
      return typeof found.value === 'string' && regex.test(found.value)
        ? null
        : fail(`${path} must match ${regex.source}`, pointerFor(path));
    }
  }
}

function stringParam(value: unknown, name: string): string {
  if (typeof value === 'string' && value.length > 0) return value;
  throw badRequest('invalid_policy_rule', `Policy rule parameter ${name} must be a string`);
}

function numberParam(value: unknown, fallback: number): number {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return parsed;
  throw badRequest('invalid_policy_rule', 'Policy rule number parameter is invalid');
}

function arrayParam(value: unknown, name: string): unknown[] {
  if (Array.isArray(value)) return value;
  throw badRequest('invalid_policy_rule', `Policy rule parameter ${name} must be an array`);
}

function regexParam(value: unknown, name: string): RegExp {
  return new RegExp(stringParam(value, name));
}

function pointerFor(path: string): string {
  if (path.startsWith('/')) return path;
  return `/${path.split('.').map((part) => part.replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`;
}

function getByPath(root: unknown, path: string): { exists: boolean; value: unknown } {
  const parts = path.startsWith('/') ? path.slice(1).split('/').map(unescapePointer) : path.split('.');
  let value = root;
  for (const part of parts) {
    if (!value || typeof value !== 'object' || !(part in (value as Record<string, unknown>))) {
      return { exists: false, value: undefined };
    }
    value = (value as Record<string, unknown>)[part];
  }
  return { exists: true, value };
}

function unescapePointer(value: string): string {
  return value.replace(/~1/g, '/').replace(/~0/g, '~');
}

function topLevelTags(spec: Record<string, unknown>): string[] {
  return Array.isArray(spec.tags)
    ? spec.tags
        .map((tag) => (tag && typeof tag === 'object' ? (tag as { name?: unknown }).name : null))
        .filter((tag): tag is string => typeof tag === 'string')
    : [];
}

function plugins(spec: Record<string, unknown>): Array<{ name?: unknown }> {
  const proxy = spec['x-ferrum-proxy'];
  if (!proxy || typeof proxy !== 'object' || Array.isArray(proxy)) return [];
  const raw = (proxy as { plugins?: unknown }).plugins;
  return Array.isArray(raw)
    ? raw.filter((plugin): plugin is { name?: unknown } => !!plugin && typeof plugin === 'object')
    : [];
}

function missingOperationSummary(spec: Record<string, unknown>): string | null {
  const paths = spec.paths;
  if (!paths || typeof paths !== 'object' || Array.isArray(paths)) return null;
  const methods = new Set(['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace']);
  for (const [path, item] of Object.entries(paths)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    for (const [method, operation] of Object.entries(item)) {
      if (!methods.has(method.toLowerCase())) continue;
      if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
        return `/paths/${path.replace(/\//g, '~1')}/${method}`;
      }
      const summary = (operation as { summary?: unknown }).summary;
      if (typeof summary !== 'string' || !summary.trim()) {
        return `/paths/${path.replace(/\//g, '~1')}/${method}/summary`;
      }
    }
  }
  return null;
}

