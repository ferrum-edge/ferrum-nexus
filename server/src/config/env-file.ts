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
 *
 * Nothing here logs a value: at most the path of the file that was used.
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

/**
 * The process environment layered over the values of `.env` (if any).
 *
 * @returns the merged record and the path that was read, so a caller can say
 *   which file it used without ever printing what was in it
 */
export function environmentWithEnvFile(
  env: EnvRecord = process.env,
  cwd: string = process.cwd(),
): { env: EnvRecord; file: string | null } {
  const file = findEnvFile(cwd);
  if (file === null) return { env, file: null };
  const fromFile = parseEnv(readFileSync(file, 'utf8'));
  const merged: EnvRecord = { ...fromFile };
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) merged[key] = value;
  }
  return { env: merged, file };
}
