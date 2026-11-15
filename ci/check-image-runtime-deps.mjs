#!/usr/bin/env node
// Checks that every runtime dependency of the given package directories is
// installed where Node's resolver looks for it, transitively. Run inside the
// production image (`node check-image-runtime-deps.mjs /app/server`), it fails
// when the image dropped a package npm placed in a workspace's own
// node_modules, which is how a lock that nested better-sqlite3 under
// server/node_modules shipped an image that could not start (#718).
//
// Only presence is checked, not versions: `npm ci` already enforced those when
// the image was built. `optionalDependencies` (platform binaries) and
// `peerDependencies` (provided by the dependant) may be absent.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Node's node_modules lookup for `name` from `fromDir`; the package's real directory, or null. */
export function findPackage(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    if (parse(dir).base !== 'node_modules') {
      const candidate = join(dir, 'node_modules', name);
      if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Every unresolved runtime dependency reachable from `roots`, as `{ from, name }`. */
export function missingRuntimeDependencies(roots) {
  const missing = [];
  const seen = new Set();
  const queue = roots.map((root) => realpathSync(resolve(root)));
  while (queue.length > 0) {
    const dir = queue.shift();
    if (seen.has(dir)) continue;
    seen.add(dir);
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const optional = new Set(Object.keys(manifest.optionalDependencies ?? {}));
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      if (optional.has(name)) continue;
      const found = findPackage(name, dir);
      if (found) queue.push(found);
      else missing.push({ from: dir, name });
    }
    for (const name of optional) {
      const found = findPackage(name, dir);
      if (found) queue.push(found);
    }
  }
  return missing;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const roots = process.argv.slice(2);
  if (roots.length === 0) {
    console.error('usage: check-image-runtime-deps.mjs <package-dir>...');
    process.exit(2);
  }
  const missing = missingRuntimeDependencies(roots);
  for (const { from, name } of missing) {
    console.log(`::error::${name} (a dependency of ${from}) does not resolve`);
  }
  if (missing.length > 0) process.exit(1);
  console.log(`Every runtime dependency of ${roots.join(', ')} resolves.`);
}
