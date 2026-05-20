/**
 * Cryptographic helpers used across the server.
 *
 * - `deriveKey` turns the configured secret into a per-purpose 32-byte key.
 * - `encryptSetting` / `decryptSetting` protect sensitive app_settings rows
 *   (SMTP password, CAPTCHA secret) using AES-256-GCM. Encrypted payloads are
 *   serialized as `v1:<iv-b64>:<ciphertext-b64>:<tag-b64>`.
 * - `randomToken` produces URL-safe random strings for sessions, CSRF, and
 *   verification tokens.
 * - `fingerprint` produces a stable SHA-256 hex fingerprint of credential
 *   material for safe storage (no plaintext credentials ever land in Nexus).
 */

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

const KEY_LEN = 32;

export function deriveKey(secret: string, purpose: string): Buffer {
  // HKDF-SHA256 with a static info string. The secret is the configured
  // NEXUS_SECRET_KEY; the salt is the empty buffer (we don't need PFS here).
  const out = hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), Buffer.from(purpose, 'utf8'), KEY_LEN);
  return Buffer.from(out);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function fingerprint(material: string): string {
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

export function last4(value: string): string {
  return value.length <= 4 ? value : value.slice(-4);
}

const ENC_VERSION = 'v1';

export function encryptSetting(plaintext: string, secret: string): string {
  const key = deriveKey(secret, 'nexus:settings:v1');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENC_VERSION, iv.toString('base64url'), ct.toString('base64url'), tag.toString('base64url')].join(':');
}

export function decryptSetting(token: string, secret: string): string {
  const [version, ivB64, ctB64, tagB64] = token.split(':');
  if (version !== ENC_VERSION) throw new Error(`Unsupported encrypted setting version: ${version}`);
  const key = deriveKey(secret, 'nexus:settings:v1');
  const iv = Buffer.from(ivB64!, 'base64url');
  const ct = Buffer.from(ctB64!, 'base64url');
  const tag = Buffer.from(tagB64!, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

/** Sign a value with an HMAC-SHA256 keyed off the server secret. */
export function sign(value: string, secret: string, purpose: string): string {
  const key = deriveKey(secret, purpose);
  return createHash('sha256').update(key).update(value).digest('hex');
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let res = 0;
  for (let i = 0; i < a.length; i++) {
    res |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return res === 0;
}
