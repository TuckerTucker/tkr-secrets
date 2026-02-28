/**
 * Cryptographic primitives for secrets encryption.
 * Uses AES-256-GCM with scrypt KDF via node:crypto (Bun-native).
 */

import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';

const KEY_LENGTH = 32;
const SALT_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const SCRYPT_COST = 16384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELISM = 1;

/** Generates a random salt as hex string. */
export function generateSalt(): string {
  return randomBytes(SALT_LENGTH).toString('hex');
}

/** Derives a 256-bit key from password and salt using scrypt. */
export function deriveKey(password: string, salt: string): Buffer {
  return scryptSync(password, Buffer.from(salt, 'hex'), KEY_LENGTH, {
    cost: SCRYPT_COST,
    blockSize: SCRYPT_BLOCK_SIZE,
    parallelization: SCRYPT_PARALLELISM,
  });
}

/** Encrypts plaintext with AES-256-GCM. Returns iv:ciphertext:tag as hex. */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${encrypted.toString('hex')}:${tag.toString('hex')}`;
}

/**
 * Generates a 256-bit random vault key.
 *
 * The vault key (VK) is the actual encryption key for secrets. It is wrapped
 * by password-derived keys and recovery keys, never stored in plaintext.
 *
 * @returns 32-byte random Buffer.
 */
export function generateVaultKey(): Buffer {
  return randomBytes(KEY_LENGTH);
}

/**
 * Wraps (encrypts) a target key using AES-256-GCM.
 *
 * The target key is hex-encoded before encryption to ensure clean round-tripping
 * through the string-based encrypt/decrypt functions.
 *
 * @param wrappingKey - 32-byte key used to wrap (e.g., password-derived key or recovery key).
 * @param targetKey - 32-byte key being wrapped (e.g., vault key).
 * @returns Wrapped key as an `iv:ciphertext:tag` hex string.
 */
export function wrapKey(wrappingKey: Buffer, targetKey: Buffer): string {
  return encrypt(targetKey.toString('hex'), wrappingKey);
}

/**
 * Unwraps (decrypts) a previously wrapped key.
 *
 * @param wrappingKey - 32-byte key used to unwrap (must match the key used to wrap).
 * @param wrappedKey - `iv:ciphertext:tag` hex string from {@link wrapKey}.
 * @returns 32-byte Buffer containing the original target key.
 * @throws Error on GCM auth tag verification failure (wrong wrapping key).
 */
export function unwrapKey(wrappingKey: Buffer, wrappedKey: string): Buffer {
  return Buffer.from(decrypt(wrappedKey, wrappingKey), 'hex');
}

/** Decrypts an iv:ciphertext:tag hex string with AES-256-GCM. */
export function decrypt(ciphertext: string, key: Buffer): string {
  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    throw new Error('invalid ciphertext format');
  }
  const iv = Buffer.from(parts[0], 'hex');
  const encrypted = Buffer.from(parts[1], 'hex');
  const tag = Buffer.from(parts[2], 'hex');

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final('utf8');
}
