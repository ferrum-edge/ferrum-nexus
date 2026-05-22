import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { Logger } from 'pino';
import type { GovernancePolicy } from '@ferrum-nexus/shared';
import type { NexusStore } from '../db/store.js';

const POLICY_KEY = 'governance_policy';

export async function seedPolicyFromFile(
  store: NexusStore,
  filePath: string | undefined,
  logger: Logger,
): Promise<void> {
  if (!filePath || !existsSync(filePath)) return;
  const existing = await store.settings.get<GovernancePolicy>(POLICY_KEY);
  if (existing) return;
  const raw = readFileSync(filePath, 'utf8');
  const parsed = parseYaml(raw) as Record<string, unknown>;
  const policy: GovernancePolicy = {
    version: Number(parsed.version ?? 1),
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    updatedBy: typeof parsed.updatedBy === 'string' ? parsed.updatedBy : null,
    rules: Array.isArray(parsed.rules) ? (parsed.rules as GovernancePolicy['rules']) : [],
  };
  await store.settings.set(POLICY_KEY, policy);
  logger.info({ filePath, rules: policy.rules.length }, 'seeded governance policy from file');
}
