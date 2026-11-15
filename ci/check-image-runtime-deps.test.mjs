// node --test ci/check-image-runtime-deps.test.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { missingRuntimeDependencies } from './check-image-runtime-deps.mjs';

function pkg(dir, manifest) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
}

/**
 * The runtime image's layout: /app/server and /app/shared, the root
 * node_modules with the workspace symlink, and whatever `nested` adds.
 */
function image(t, { nested = false, copyServerModules = true } = {}) {
  const app = mkdtempSync(join(tmpdir(), 'image-deps-'));
  t.after(() => rmSync(app, { recursive: true, force: true }));
  pkg(join(app, 'shared'), { name: '@ferrum-nexus/shared', dependencies: {} });
  pkg(join(app, 'server'), {
    name: '@ferrum-nexus/server',
    dependencies: { '@ferrum-nexus/shared': '*', 'better-sqlite3': '^13.1.1', fastify: '^5.0.0' },
    optionalDependencies: { 'not-on-this-platform': '1.0.0' },
  });
  mkdirSync(join(app, 'node_modules', '@ferrum-nexus'), { recursive: true });
  symlinkSync('../../shared', join(app, 'node_modules', '@ferrum-nexus', 'shared'));
  pkg(join(app, 'node_modules', 'fastify'), {
    name: 'fastify',
    dependencies: { 'light-my-request': '^6.0.0' },
    peerDependencies: { 'not-installed-peer': '*' },
  });
  pkg(join(app, 'node_modules', 'light-my-request'), { name: 'light-my-request' });
  // #718: npm placed better-sqlite3 in the workspace instead of the root.
  const sqliteHome = nested ? join(app, 'server') : app;
  if (!nested || copyServerModules) {
    pkg(join(sqliteHome, 'node_modules', 'better-sqlite3'), {
      name: 'better-sqlite3',
      dependencies: { bindings: '^1.5.0' },
    });
    pkg(join(sqliteHome, 'node_modules', 'bindings'), { name: 'bindings' });
  }
  return app;
}

test('a hoisted image resolves every runtime dependency', (t) => {
  const app = image(t);
  assert.deepEqual(missingRuntimeDependencies([join(app, 'server')]), []);
});

test('a dependency nested under server/node_modules resolves when the image copies it', (t) => {
  const app = image(t, { nested: true, copyServerModules: true });
  assert.deepEqual(missingRuntimeDependencies([join(app, 'server')]), []);
});

test('an image without server/node_modules fails for the nested dependency (#718)', (t) => {
  const app = image(t, { nested: true, copyServerModules: false });
  const missing = missingRuntimeDependencies([join(app, 'server')]);
  assert.deepEqual(
    missing.map(({ name }) => name),
    ['better-sqlite3'],
  );
});

test('a missing transitive dependency fails', (t) => {
  const app = image(t);
  rmSync(join(app, 'node_modules', 'light-my-request'), { recursive: true });
  const missing = missingRuntimeDependencies([join(app, 'server')]);
  assert.deepEqual(
    missing.map(({ name }) => name),
    ['light-my-request'],
  );
  assert.match(missing[0].from, /node_modules[\\/]fastify$/);
});

test('a dependency of the symlinked shared workspace is resolved from /app/shared', (t) => {
  const app = image(t);
  pkg(join(app, 'shared'), { name: '@ferrum-nexus/shared', dependencies: { zod: '^4.0.0' } });
  const missing = missingRuntimeDependencies([join(app, 'server')]);
  assert.deepEqual(
    missing.map(({ name }) => name),
    ['zod'],
  );
  assert.match(missing[0].from, /[\\/]shared$/);
  pkg(join(app, 'shared', 'node_modules', 'zod'), { name: 'zod' });
  assert.deepEqual(missingRuntimeDependencies([join(app, 'server')]), []);
});
