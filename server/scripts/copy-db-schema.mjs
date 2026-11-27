import { cpSync, existsSync, rmSync } from 'node:fs';

// Copy the frozen base schema and the forward migrations beside the compiled
// loaders, replacing stale files when one is renamed or deleted. The baseline
// ships no migration, so `src/db/migrations/` may not exist yet.
for (const directory of ['schema', 'migrations']) {
  const source = new URL(`../src/db/${directory}/`, import.meta.url);
  const destination = new URL(`../dist/db/${directory}/`, import.meta.url);
  rmSync(destination, { recursive: true, force: true });
  if (existsSync(source)) cpSync(source, destination, { recursive: true });
}
