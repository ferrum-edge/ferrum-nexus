/** Physical storage for complete conversion/restore journals and secret-bearing owner evidence. */
import { randomBytes } from 'node:crypto';

import type { NexusStore } from '../db/store.js';
import { isLegacyDeploymentSnapshot } from '../ferrum-admin/deployment.js';
import type { NexusCrypto } from '../lib/crypto.js';
import { conflict } from '../lib/errors.js';

// Every encrypted chunk is below 1 MiB, including JSON/base64 expansion, well
// below MongoDB's 16 MiB BSON document limit and ordinary SQL packet limits.
const INLINE_BYTES = 512 * 1024;
const CHUNK_CHARACTERS = 512 * 1024;
const FORMAT = 'gateway-recovery-chunks-v1';

interface Manifest {
  format: typeof FORMAT;
  key: string;
  generation: string;
  count: number;
  characters: number;
  fingerprint: string;
}

interface Chunk {
  key: string;
  generation: string;
  index: number;
  data: string;
}

function chunkKey(manifest: Manifest, index: number): string {
  return `gateway_recovery_chunk:${manifest.generation}:${index}`;
}

function manifestFor(value: unknown, key: string): Manifest | null {
  if (typeof value !== 'object' || value === null || !('format' in value)) return null;
  const manifest = value as Manifest;
  if (
    manifest.format !== FORMAT ||
    manifest.key !== key ||
    typeof manifest.generation !== 'string' ||
    !/^[a-f0-9]{32}$/.test(manifest.generation) ||
    !Number.isSafeInteger(manifest.count) ||
    manifest.count < 1 ||
    !Number.isSafeInteger(manifest.characters) ||
    manifest.characters < 1 ||
    Math.ceil(manifest.characters / CHUNK_CHARACTERS) !== manifest.count ||
    typeof manifest.fingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(manifest.fingerprint)
  ) {
    throw conflict('The encrypted gateway recovery manifest is invalid');
  }
  return manifest;
}

async function load(
  tx: NexusStore,
  crypto: NexusCrypto,
  key: string,
): Promise<{ value: unknown; manifest: Manifest | null } | null> {
  const row = await tx.settings.get(key);
  if (!row) return null;
  if (!row.encrypted || typeof row.value !== 'string') {
    throw conflict('The encrypted gateway recovery record is unavailable');
  }
  const value = crypto.decryptJson<unknown>(row.value);
  const manifest = manifestFor(value, key);
  if (!manifest) return { value, manifest: null };
  const parts: string[] = [];
  for (let index = 0; index < manifest.count; index += 1) {
    const row = await tx.settings.get(chunkKey(manifest, index));
    if (!row?.encrypted || typeof row.value !== 'string') {
      throw conflict('An encrypted gateway recovery chunk is unavailable');
    }
    const chunk = crypto.decryptJson<Chunk>(row.value);
    if (
      chunk.key !== key ||
      chunk.generation !== manifest.generation ||
      chunk.index !== index ||
      typeof chunk.data !== 'string' ||
      chunk.data.length !==
        Math.min(CHUNK_CHARACTERS, manifest.characters - index * CHUNK_CHARACTERS)
    ) {
      throw conflict('An encrypted gateway recovery chunk does not match its manifest');
    }
    parts.push(chunk.data);
  }
  const encoded = parts.join('');
  if (crypto.fingerprint(encoded) !== manifest.fingerprint) {
    throw conflict('The complete encrypted gateway recovery journal does not match its manifest');
  }
  return {
    value: JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as unknown,
    manifest,
  };
}

/**
 * Authority format of the journals this release writes: every deployment snapshot
 * a marked journal holds is Edge v0.9.13 authority (`admin-deployment-snapshot`
 * v2, digest-only spec evidence plus `api_spec_contents`). Journals written before
 * carry no marker and may hold Edge v0.9.12 authority. They stay readable for
 * custody checks and inspection; that authority is refused before any request,
 * because Edge v0.9.13 answers its token with `412`.
 */
export const JOURNAL_AUTHORITY_FORMAT = 2;

/** Every deployment snapshot a journal holds, wherever it is nested. */
function heldAuthorities(value: unknown, found: unknown[] = []): unknown[] {
  if (typeof value !== 'object' || value === null) return found;
  if (
    !Array.isArray(value) &&
    (value as Record<string, unknown>).profile === 'deployment-v1' &&
    Object.hasOwn(value, 'namespace_etag')
  ) {
    found.push(value);
    return found;
  }
  for (const child of Object.values(value)) heldAuthorities(child, found);
  return found;
}

/** Mark a journal holding only current authority; one with legacy authority stays unmarked. */
export function stampJournalAuthorityFormat<T extends object>(journal: T): T {
  const target = journal as Record<string, unknown>;
  if (heldAuthorities(journal).some(isLegacyDeploymentSnapshot)) {
    delete target.authorityFormat;
  } else {
    target.authorityFormat = JOURNAL_AUTHORITY_FORMAT;
  }
  return journal;
}

/** Unmarked journals stay readable; an unknown or inconsistent marker is refused. */
export function assertJournalAuthorityFormat(journal: unknown): void {
  if (typeof journal !== 'object' || journal === null) return;
  const format = (journal as Record<string, unknown>).authorityFormat;
  if (format === undefined) return;
  if (
    format !== JOURNAL_AUTHORITY_FORMAT ||
    heldAuthorities(journal).some(isLegacyDeploymentSnapshot)
  ) {
    throw conflict('The gateway recovery journal has an unrecognized authority format; retain it', {
      kind: 'journal_authority_format_unrecognized',
    });
  }
}

/** Admit atomic custody for every existing journal, including legacy single-row authority. */
export async function readRecoveryJournal<T>(
  store: NexusStore,
  crypto: NexusCrypto,
  key: string,
): Promise<T | null> {
  const row = await store.settings.get(key);
  if (!row) return null;
  // Legacy inline authority also authorizes operations that later replace or
  // delete the journal. Refuse standalone before any caller can act on it.
  return store.transaction(
    async (tx) => {
      const journal = await load(tx, crypto, key);
      return journal ? (journal.value as T) : null;
    },
    { requireAtomic: true },
  );
}

/** Publish the complete new generation and retire the old one in the same fenced transaction. */
export async function writeRecoveryJournal(
  store: NexusStore,
  crypto: NexusCrypto,
  key: string,
  value: unknown,
): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  const entries: { key: string; value: string }[] = [];
  let sealed: string;
  if (bytes.length <= INLINE_BYTES) {
    sealed = crypto.encryptJson(value);
  } else {
    const encoded = bytes.toString('base64');
    const manifest: Manifest = {
      format: FORMAT,
      key,
      generation: randomBytes(16).toString('hex'),
      count: Math.ceil(encoded.length / CHUNK_CHARACTERS),
      characters: encoded.length,
      fingerprint: crypto.fingerprint(encoded),
    };
    for (let index = 0; index < manifest.count; index += 1) {
      const chunk: Chunk = {
        key,
        generation: manifest.generation,
        index,
        data: encoded.slice(index * CHUNK_CHARACTERS, (index + 1) * CHUNK_CHARACTERS),
      };
      entries.push({ key: chunkKey(manifest, index), value: crypto.encryptJson(chunk) });
    }
    sealed = crypto.encryptJson(manifest);
  }
  await store.transaction(
    async (tx) => {
      const previous = await load(tx, crypto, key);
      for (const entry of entries) await tx.settings.set(entry.key, entry.value, true);
      await tx.settings.set(key, sealed, true);
      if (previous?.manifest) {
        for (let index = 0; index < previous.manifest.count; index += 1) {
          await tx.settings.delete(chunkKey(previous.manifest, index));
        }
      }
    },
    { requireAtomic: true },
  );
}

/** Completion cannot strand chunks or erase a journal whose custody cannot be verified. */
export async function deleteRecoveryJournal(
  store: NexusStore,
  crypto: NexusCrypto,
  key: string,
): Promise<void> {
  if (!(await store.settings.get(key))) return;
  await store.transaction(
    async (tx) => {
      const previous = await load(tx, crypto, key);
      if (previous?.manifest) {
        for (let index = 0; index < previous.manifest.count; index += 1) {
          await tx.settings.delete(chunkKey(previous.manifest, index));
        }
      }
      await tx.settings.delete(key);
    },
    { requireAtomic: true },
  );
}
