import crypto from 'node:crypto';
import { env } from '../config/env';

/**
 * AES-256-GCM encryption for OAuth tokens.
 *
 * Format on disk: v1:<iv-hex>:<tag-hex>:<ciphertext-hex>
 * The leading version tag lets us rotate ENCRYPTION_KEY later by adding a v2
 * decrypt path and re-encrypting existing rows in the background.
 */

const VERSION = 'v1' as const;
const ALGO = 'aes-256-gcm' as const;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function getKey(): Buffer {
  const hex = env().ENCRYPTION_KEY;
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error('ENCRYPTION_KEY must be 64 hex chars (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

export function encrypt(plain: string): string {
  if (plain == null) throw new Error('encrypt: plain is required');
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

export function decrypt(blob: string): string {
  if (!blob || typeof blob !== 'string') throw new Error('decrypt: blob is required');
  const parts = blob.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('decrypt: unsupported format');
  const iv = Buffer.from(parts[1]!, 'hex');
  const tag = Buffer.from(parts[2]!, 'hex');
  const ct = Buffer.from(parts[3]!, 'hex');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('decrypt: malformed');
  const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(ct), decipher.final()]);
  return out.toString('utf-8');
}

/** Encrypt optional values, returning null when no value. Convenient for nullable token columns. */
export function encryptOptional(plain: string | null | undefined): string | null {
  if (plain == null || plain === '') return null;
  return encrypt(plain);
}

export function decryptOptional(blob: string | null | undefined): string | null {
  if (blob == null || blob === '') return null;
  return decrypt(blob);
}
