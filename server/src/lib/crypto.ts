/**
 * All cryptography used by Nexus, in one module.
 *
 * Three independent concerns, deliberately kept apart:
 *
 * 1. **Password hashing** — scrypt, self-describing string format
 *    `scrypt:N:r:p:<salt b64>:<hash b64>` so parameters can be raised later
 *    without invalidating existing hashes. Verification is constant-time.
 * 2. **Settings encryption** — AES-256-GCM over a JSON value, key HKDF-derived
 *    from `NEXUS_SECRET_KEY` with info `nexus-settings-v1`. Blob format is
 *    `v1:<iv b64>:<ciphertext b64>:<tag b64>`.
 * 3. **Session token hashing** — HMAC-SHA-256 under a *separate* HKDF-derived
 *    key (info `nexus-session-hmac-v1`), so a leaked settings key cannot be
 *    used to forge session lookups and vice versa.
 *
 * Rotating `NEXUS_SECRET_KEY` invalidates every encrypted setting and every
 * live session — see docs/operations.md for the re-encrypt flow.
 */

import {
  createHash,
  createHmac,
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

import { internal } from './errors.js';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/* ── Password hashing (scrypt) ──────────────────────────────────────────── */

/** Cost parameters used for newly created password hashes. */
export const SCRYPT_PARAMS = { N: 16_384, r: 8, p: 1, keyLength: 32 } as const;

const SCRYPT_SALT_BYTES = 16;

function scryptMaxmem(N: number, r: number): number {
  // node's default maxmem is 32 MiB; give scrypt twice its nominal 128*N*r need.
  return Math.max(32 * 1024 * 1024, 256 * N * r);
}

/**
 * Hash a plaintext password. Returns `scrypt:N:r:p:<salt b64>:<hash b64>`,
 * which is what lands in `users.password_hash`.
 */
export async function hashPassword(password: string): Promise<string> {
  const { N, r, p, keyLength } = SCRYPT_PARAMS;
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const derived = await scrypt(password, salt, keyLength, { N, r, p, maxmem: scryptMaxmem(N, r) });
  return `scrypt:${N}:${r}:${p}:${salt.toString('base64')}:${derived.toString('base64')}`;
}

/**
 * Verify a plaintext password against a stored hash. Returns `false` (never
 * throws) for malformed or unknown-scheme hashes, and compares in constant
 * time for well-formed ones.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isSafeInteger(N) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p))
    return false;
  if (N < 2 || r < 1 || p < 1 || N > 1 << 22) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4] ?? '', 'base64');
    expected = Buffer.from(parts[5] ?? '', 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = await scrypt(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: scryptMaxmem(N, r),
    });
  } catch {
    return false;
  }
  return constantTimeEqual(derived, expected);
}

/** Constant-time buffer/string comparison that does not leak length via early exit. */
export function constantTimeEqual(a: Buffer | string, b: Buffer | string): boolean {
  const ab = Buffer.isBuffer(a) ? a : Buffer.from(a, 'utf8');
  const bb = Buffer.isBuffer(b) ? b : Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Decoy compare so a length mismatch costs roughly the same as a real one.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Constant-time equality for two secrets whose lengths are themselves secret.
 *
 * {@link constantTimeEqual} compares the bytes, so a length mismatch takes a
 * different branch. Comparing the SHA-256 digests instead makes both operands
 * a fixed 32 bytes, so an attacker probing with candidates of varying length
 * learns nothing about the expected one. Used for the bootstrap token, where
 * the presented value is entirely attacker-chosen.
 */
export function secretEquals(presented: string, expected: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(presented, 'utf8').digest(),
    createHash('sha256').update(expected, 'utf8').digest(),
  );
}

/* ── Fingerprints and random material ───────────────────────────────────── */

/** Lowercase hex SHA-256 of `value` — used as the credential fingerprint. */
export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Fingerprint stored alongside a show-once credential. Alias of {@link sha256Hex},
 * named for the call site so the intent is obvious in the credentials service.
 */
export function fingerprint(secret: string): string {
  return sha256Hex(secret);
}

/** Last four characters of a secret, for identifying it in the UI. */
export function last4(secret: string): string {
  return secret.length <= 4 ? secret : secret.slice(-4);
}

/**
 * URL-safe random token (base64url, no padding). 32 bytes by default, which is
 * what session tokens and email-verification tokens use.
 */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Random API-key style secret with a readable prefix, e.g. `nxs_ab12…`. */
export function randomSecret(prefix = 'nxs', bytes = 24): string {
  return `${prefix}_${randomBytes(bytes).toString('base64url')}`;
}

/* ── Key derivation ─────────────────────────────────────────────────────── */

/** HKDF `info` label for the AES-256-GCM key protecting encrypted `app_settings`. */
export const SETTINGS_KEY_INFO = 'nexus-settings-v1';

/** HKDF `info` label for the HMAC-SHA-256 key that hashes session tokens at rest. */
export const SESSION_HMAC_KEY_INFO = 'nexus-session-hmac-v1';

/** Fixed HKDF salt. The master secret supplies the entropy; the salt only separates domains. */
const HKDF_SALT = Buffer.from('ferrum-nexus-hkdf-salt-v1', 'utf8');

/** Derive a 32-byte subkey from the master secret for the given `info` label. */
export function deriveKey(secretKey: string, info: string, length = 32): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secretKey, 'utf8'), HKDF_SALT, info, length));
}

/* ── AES-256-GCM value encryption ───────────────────────────────────────── */

const ENCRYPTED_PREFIX = 'v1';
const GCM_IV_BYTES = 12;

/**
 * Encrypt a JSON-serialisable value under `key` (32 bytes).
 * Output: `v1:<iv b64>:<ciphertext b64>:<tag b64>`.
 */
export function encryptJsonWithKey(key: Buffer, value: unknown): string {
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(value ?? null), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENCRYPTED_PREFIX,
    iv.toString('base64'),
    ciphertext.toString('base64'),
    tag.toString('base64'),
  ].join(':');
}

/**
 * Decrypt a blob produced by {@link encryptJsonWithKey}.
 *
 * Throws `NexusError(INTERNAL)` when the blob is malformed or the
 * authentication tag does not verify (wrong key, or tampering).
 */
export function decryptJsonWithKey<T = unknown>(key: Buffer, blob: string): T {
  const parts = blob.split(':');
  if (parts.length !== 4 || parts[0] !== ENCRYPTED_PREFIX) {
    throw internal('Encrypted value has an unrecognised format');
  }
  try {
    const iv = Buffer.from(parts[1] ?? '', 'base64');
    const ciphertext = Buffer.from(parts[2] ?? '', 'base64');
    const tag = Buffer.from(parts[3] ?? '', 'base64');
    if (iv.length !== GCM_IV_BYTES || tag.length !== 16) {
      throw internal('Encrypted value has an unrecognised format');
    }
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8')) as T;
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'NexusError') throw cause;
    throw internal('Encrypted value could not be decrypted', cause);
  }
}

/** True when `value` looks like a blob produced by {@link encryptJsonWithKey}. */
export function isEncryptedBlob(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(`${ENCRYPTED_PREFIX}:`);
}

/* ── Bound helper ───────────────────────────────────────────────────────── */

/** Cryptographic operations bound to a single `NEXUS_SECRET_KEY`. */
export interface NexusCrypto {
  /** Hash a password for storage (scrypt). */
  hashPassword(password: string): Promise<string>;
  /** Constant-time password verification; `false` for malformed stored hashes. */
  verifyPassword(password: string, stored: string): Promise<boolean>;
  /** Encrypt a JSON value for an `app_settings` row with `encrypted = 1`. */
  encryptJson(value: unknown): string;
  /** Decrypt an `app_settings` blob. Throws on tampering or a rotated key. */
  decryptJson<T = unknown>(blob: string): T;
  /** Mint a fresh opaque session token (returned to the browser in a cookie). */
  newSessionToken(): string;
  /** HMAC-SHA-256 of a session/verification token — this is what the DB stores. */
  hashToken(token: string): string;
  /** Lowercase hex SHA-256 fingerprint of a credential secret. */
  fingerprint(secret: string): string;
}

/** Build the {@link NexusCrypto} helper for a master secret. */
export function createCrypto(secretKey: string): NexusCrypto {
  const settingsKey = deriveKey(secretKey, SETTINGS_KEY_INFO);
  const sessionKey = deriveKey(secretKey, SESSION_HMAC_KEY_INFO);
  return {
    hashPassword,
    verifyPassword,
    encryptJson: (value) => encryptJsonWithKey(settingsKey, value),
    decryptJson: <T>(blob: string) => decryptJsonWithKey<T>(settingsKey, blob),
    newSessionToken: () => randomToken(32),
    hashToken: (token) => createHmac('sha256', sessionKey).update(token).digest('hex'),
    fingerprint,
  };
}
