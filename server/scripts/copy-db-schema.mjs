import { cpSync, rmSync } from 'node:fs';

const source = new URL('../src/db/migrations/', import.meta.url);
const destination = new URL('../dist/db/migrations/', import.meta.url);

// Remove stale assets when a buildout schema change deletes or squashes files.
rmSync(destination, { recursive: true, force: true });
cpSync(source, destination, { recursive: true });
