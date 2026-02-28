import { describe, test, expect } from 'bun:test';
import { generateSalt, deriveKey, encrypt, decrypt } from './crypto.js';

describe('crypto', () => {
  test('generateSalt returns hex string of correct length', () => {
    const salt = generateSalt();
    expect(salt).toMatch(/^[0-9a-f]{64}$/);
    expect(generateSalt()).not.toBe(salt);
  });

  test('deriveKey returns deterministic 32-byte buffer', () => {
    const salt = generateSalt();
    const key1 = deriveKey('password', salt);
    const key2 = deriveKey('password', salt);
    expect(key1.length).toBe(32);
    expect(Buffer.compare(key1, key2)).toBe(0);
  });

  test('deriveKey produces different keys for different passwords', () => {
    const salt = generateSalt();
    const k1 = deriveKey('alpha', salt);
    const k2 = deriveKey('bravo', salt);
    expect(Buffer.compare(k1, k2)).not.toBe(0);
  });

  test('encrypt/decrypt round-trip', () => {
    const salt = generateSalt();
    const key = deriveKey('test-password', salt);
    const plaintext = 'sk-abc123-secret-key';
    const ciphertext = encrypt(plaintext, key);
    expect(ciphertext).not.toContain(plaintext);
    expect(decrypt(ciphertext, key)).toBe(plaintext);
  });

  test('decrypt with wrong key throws', () => {
    const salt = generateSalt();
    const key1 = deriveKey('correct', salt);
    const key2 = deriveKey('wrong', salt);
    const ciphertext = encrypt('secret', key1);
    expect(() => decrypt(ciphertext, key2)).toThrow();
  });

  test('decrypt with invalid format throws', () => {
    const key = deriveKey('test', generateSalt());
    expect(() => decrypt('invalid', key)).toThrow('invalid ciphertext format');
  });

  test('each encryption produces unique ciphertext (random IV)', () => {
    const key = deriveKey('test', generateSalt());
    const c1 = encrypt('same', key);
    const c2 = encrypt('same', key);
    expect(c1).not.toBe(c2);
  });
});
