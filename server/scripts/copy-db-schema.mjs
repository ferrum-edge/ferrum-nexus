import { cpSync, rmSync } from 'node:fs';

const source = new URL('../src/db/schema/', import.meta.url);
const destination = new URL('../dist/db/schema/', import.meta.url);

// Remove stale assets when a schema file is renamed or deleted, and the
// pre-0.6 migration files an older build may have left in dist/.
rmSync(destination, { recursive: true, force: true });
rmSync(new URL('../dist/db/migrations/', import.meta.url), { recursive: true, force: true });
cpSync(source, destination, { recursive: true });
