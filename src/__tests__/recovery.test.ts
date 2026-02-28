import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import {
  generateRecoveryKey,
  recoveryKeyToMnemonic,
  mnemonicToRecoveryKey,
  parseRecoveryKeyInput,
  generateRecoveryQR,
  buildRecoveryKeyMaterial,
  buildRecoveryFile,
} from '../recovery.js';

describe('generateRecoveryKey', () => {
  test('returns a 32-byte Buffer', () => {
    const rk = generateRecoveryKey();
    expect(Buffer.isBuffer(rk)).toBe(true);
    expect(rk.length).toBe(32);
  });
});

describe('mnemonic round-trip', () => {
  test('key to mnemonic and back produces the same key', () => {
    const key = generateRecoveryKey();
    const mnemonic = recoveryKeyToMnemonic(key);
    const restored = mnemonicToRecoveryKey(mnemonic);

    expect(restored.equals(key)).toBe(true);
  });

  test('mnemonic is 24 lowercase words', () => {
    const key = generateRecoveryKey();
    const mnemonic = recoveryKeyToMnemonic(key);
    const words = mnemonic.split(' ');

    expect(words.length).toBe(24);
    for (const word of words) {
      expect(word).toBe(word.toLowerCase());
      expect(word.length).toBeGreaterThan(0);
    }
  });

  test('mnemonicToRecoveryKey throws on invalid mnemonic', () => {
    expect(() => mnemonicToRecoveryKey('not a valid mnemonic phrase')).toThrow('invalid BIP39 mnemonic');
  });
});

describe('parseRecoveryKeyInput', () => {
  test('parses a 64-character hex string', () => {
    const key = generateRecoveryKey();
    const hex = key.toString('hex');

    const parsed = parseRecoveryKeyInput(hex);
    expect(parsed.equals(key)).toBe(true);
  });

  test('parses a 24-word mnemonic', () => {
    const key = generateRecoveryKey();
    const mnemonic = recoveryKeyToMnemonic(key);

    const parsed = parseRecoveryKeyInput(mnemonic);
    expect(parsed.equals(key)).toBe(true);
  });

  test('parses hex with leading/trailing whitespace', () => {
    const key = generateRecoveryKey();
    const hex = `  ${key.toString('hex')}  `;

    const parsed = parseRecoveryKeyInput(hex);
    expect(parsed.equals(key)).toBe(true);
  });

  test('throws on short hex string', () => {
    expect(() => parseRecoveryKeyInput('abcd1234')).toThrow('invalid recovery key length');
  });

  test('throws on invalid characters', () => {
    expect(() => parseRecoveryKeyInput('zzzz')).toThrow('invalid recovery key format');
  });

  test('throws on wrong mnemonic word count', () => {
    expect(() => parseRecoveryKeyInput('abandon abandon abandon')).toThrow('invalid BIP39 mnemonic');
  });
});

describe('generateRecoveryQR', () => {
  test('returns a base64-encoded PNG', async () => {
    const key = generateRecoveryKey();
    const qr = await generateRecoveryQR('test-vault', key);

    // Decode base64 and check for PNG magic bytes
    const pngBuffer = Buffer.from(qr, 'base64');
    const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // \x89PNG
    expect(pngBuffer.subarray(0, 4).equals(pngMagic)).toBe(true);
  });
});

describe('buildRecoveryKeyMaterial', () => {
  test('returns mnemonic, raw hex, and qr fields', async () => {
    const key = generateRecoveryKey();
    const material = await buildRecoveryKeyMaterial('test-vault', key);

    expect(typeof material.mnemonic).toBe('string');
    expect(material.mnemonic.split(' ').length).toBe(24);

    expect(typeof material.raw).toBe('string');
    expect(material.raw).toBe(key.toString('hex'));
    expect(material.raw.length).toBe(64);

    expect(typeof material.qr).toBe('string');
    // QR is valid base64 PNG
    const pngBuffer = Buffer.from(material.qr, 'base64');
    expect(pngBuffer[0]).toBe(0x89);
  });

  test('mnemonic and raw hex are consistent', async () => {
    const key = generateRecoveryKey();
    const material = await buildRecoveryKeyMaterial('test-vault', key);

    const restoredFromMnemonic = mnemonicToRecoveryKey(material.mnemonic);
    const restoredFromHex = Buffer.from(material.raw, 'hex');

    expect(restoredFromMnemonic.equals(key)).toBe(true);
    expect(restoredFromHex.equals(key)).toBe(true);
  });
});

describe('buildRecoveryFile', () => {
  test('returns valid JSON with expected fields', () => {
    const key = generateRecoveryKey();
    const content = buildRecoveryFile('my-vault', key);
    const parsed = JSON.parse(content);

    expect(parsed.vault).toBe('my-vault');
    expect(parsed.recoveryKey).toBe(key.toString('hex'));
    expect(parsed.mnemonic).toBe(recoveryKeyToMnemonic(key));
    expect(typeof parsed.createdAt).toBe('string');
    // Verify ISO 8601 format
    expect(new Date(parsed.createdAt).toISOString()).toBe(parsed.createdAt);
  });
});
