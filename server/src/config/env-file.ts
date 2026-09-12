/**
 * Local `.env` support for the two entry points that read `process.env`.
 *
 * The quickstart says "copy `.env.example` to `.env`, edit it, run
 * `npm run migrate` and `npm run dev`" — and nothing used to read that file, so
 * a clean checkout failed with "NEXUS_SECRET_KEY is required". Node's own
 * `util.parseEnv` does the parsing (quotes, `#` comments, `export` prefixes);
 * this module only decides *which* file and *who wins*:
 *
 * - The file is looked up in the working directory and then its parent. Every
 *   workspace script runs with `server/` as the working directory, and the
 *   documented file lives one level up at the repository root.
 * - **The real environment always wins.** A value exported in the shell, set by
 *   a container runtime or injected by an orchestrator is never overridden by
 *   the file, so a deployed image with no `.env` behaves exactly as before and a
 *   one-off `NEXUS_PORT=9000 npm run dev` still works.
 * - Silently winning is the problem for two of them, so
 *   {@link guardedEnvOverrides} reports when the environment disagrees with the
 *   file about {@link GUARDED_ENV_KEYS}. It only reports; the precedence rule
 *   above is unchanged, and what the caller does about it is `main()`'s
 *   decision.
 *
 * Nothing here logs a value: at most the path of the file that was used, and
 * the two guarded values a caller chose to report.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseEnv } from 'node:util';

import type { EnvRecord } from './index.js';

/** Where a `.env` file is looked for, in order: the working directory, then its parent. */
export function envFileCandidates(cwd: string = process.cwd()): string[] {
  const here = resolve(cwd, '.env');
  const parent = resolve(dirname(cwd), '.env');
  return parent === here ? [here] : [here, parent];
}

/** The first existing candidate, or `null` when there is no `.env` to load. */
export function findEnvFile(cwd: string = process.cwd()): string | null {
  return envFileCandidates(cwd).find((candidate) => existsSync(candidate)) ?? null;
}

/** Parse the `.env` file at `file` into a record, with no process-env layering. */
export function readEnvFile(file: string): EnvRecord {
  return parseEnv(readFileSync(file, 'utf8'));
}

/**
 * Keys whose silent override changes *where the portal publishes*.
 *
 * "The real environment always wins" is the right rule and stays the rule —
 * but for these two it is also a footgun (ferrum-nexus#231). A
 * `FERRUM_NAMESPACE` left exported by unrelated tooling redirects every
 * publish into a namespace the gateway's data plane does not route, and a
 * stale `FERRUM_ADMIN_URL` points the portal at a different gateway entirely.
 * Both look exactly like a working portal until an `invoke_url` answers `404`.
 *
 * Nothing else is guarded: every other variable either fails loudly when it is
 * wrong or is meant to be overridden per process.
 */
export const GUARDED_ENV_KEYS = ['FERRUM_NAMESPACE', 'FERRUM_ADMIN_URL'] as const;

/** One guarded key the process environment overrode with a different value. */
export interface EnvOverride {
  /** The variable's name. */
  key: (typeof GUARDED_ENV_KEYS)[number];
  /** What the `.env` file says — the value the operator is probably reading. */
  fromFile: string;
  /** What the process environment says. This is the value that wins. */
  fromProcess: string;
}

/**
 * Guarded keys the process environment sets to something **other** than the
 * `.env` file's value.
 *
 * A key the file does not set is not an override — there is nothing to
 * disagree with — and neither is one whose two values are identical.
 */
export function guardedEnvOverrides(env: EnvRecord, fromFile: EnvRecord): EnvOverride[] {
  const overrides: EnvOverride[] = [];
  for (const key of GUARDED_ENV_KEYS) {
    const fileValue = fromFile[key];
    const processValue = env[key];
    if (fileValue === undefined || processValue === undefined) continue;
    if (fileValue === processValue) continue;
    overrides.push({ key, fromFile: fileValue, fromProcess: processValue });
  }
  return overrides;
}

/**
 * The process environment layered over the values of `.env` (if any).
 *
 * @returns the merged record, the path that was read — so a caller can say
 *   which file it used without ever printing what was in it — and the
 *   {@link GUARDED_ENV_KEYS} the environment silently overrode
 */
export function environmentWithEnvFile(
  env: EnvRecord = process.env,
  cwd: string = process.cwd(),
): { env: EnvRecord; file: string | null; overrides: EnvOverride[] } {
  const file = findEnvFile(cwd);
  if (file === null) return { env, file: null, overrides: [] };
  const fromFile = readEnvFile(file);
  const merged: EnvRecord = { ...fromFile };
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) merged[key] = value;
  }
  return { env: merged, file, overrides: guardedEnvOverrides(env, fromFile) };
}
