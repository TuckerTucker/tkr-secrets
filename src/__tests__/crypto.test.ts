import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { generateVaultKey, wrapKey, unwrapKey } from '../crypto.js';

describe('generateVaultKey', () => {
  test('returns a 32-byte Buffer', () => {
    const vk = generateVaultKey();
    expect(Buffer.isBuffer(vk)).toBe(true);
    expect(vk.length).toBe(32);
  });

  test('returns unique values on successive calls', () => {
    const a = generateVaultKey();
    const b = generateVaultKey();
    expect(a.equals(b)).toBe(false);
  });
});

describe('wrapKey / unwrapKey', () => {
  test('round-trips a vault key through wrap and unwrap', () => {
    const wrappingKey = randomBytes(32);
    const targetKey = generateVaultKey();

    const wrapped = wrapKey(wrappingKey, targetKey);
    const unwrapped = unwrapKey(wrappingKey, wrapped);

    expect(unwrapped.equals(targetKey)).toBe(true);
  });

  test('wrapped output uses iv:ciphertext:tag hex format', () => {
    const wrappingKey = randomBytes(32);
    const targetKey = generateVaultKey();

    const wrapped = wrapKey(wrappingKey, targetKey);
    const parts = wrapped.split(':');

    expect(parts.length).toBe(3);
    // All parts should be valid hex
    for (const part of parts) {
      expect(/^[0-9a-f]+$/.test(part)).toBe(true);
    }
  });

  test('throws on unwrap with wrong key', () => {
    const correctKey = randomBytes(32);
    const wrongKey = randomBytes(32);
    const targetKey = generateVaultKey();

    const wrapped = wrapKey(correctKey, targetKey);

    expect(() => unwrapKey(wrongKey, wrapped)).toThrow();
  });

  test('unwrapped key is exactly 32 bytes', () => {
    const wrappingKey = randomBytes(32);
    const targetKey = generateVaultKey();

    const wrapped = wrapKey(wrappingKey, targetKey);
    const unwrapped = unwrapKey(wrappingKey, wrapped);

    expect(unwrapped.length).toBe(32);
  });
});
