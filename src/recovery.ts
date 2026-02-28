/**
 * Recovery key generation, BIP39 mnemonic encoding, and QR code generation.
 *
 * Recovery keys provide an alternative path to unwrap the vault key when
 * the user's password is unavailable.
 */

import { randomBytes } from 'node:crypto';
import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from 'bip39';
import QRCode from 'qrcode';
import type { RecoveryKeyMaterial } from './types.js';

const KEY_LENGTH = 32;
const HEX_KEY_LENGTH = 64;
const MNEMONIC_WORD_COUNT = 24;

/**
 * Generates a 256-bit random recovery key.
 *
 * @returns 32-byte random Buffer.
 */
export function generateRecoveryKey(): Buffer {
  return randomBytes(KEY_LENGTH);
}

/**
 * Encodes a 256-bit key as a 24-word BIP39 mnemonic.
 *
 * @param key - 32-byte Buffer to encode.
 * @returns Space-delimited 24-word lowercase mnemonic.
 */
export function recoveryKeyToMnemonic(key: Buffer): string {
  return entropyToMnemonic(key.toString('hex'));
}

/**
 * Decodes a 24-word BIP39 mnemonic back to a 256-bit key.
 *
 * @param mnemonic - Space-delimited 24-word BIP39 mnemonic.
 * @returns 32-byte Buffer.
 * @throws Error if the mnemonic is invalid (wrong word count, invalid words, bad checksum).
 */
export function mnemonicToRecoveryKey(mnemonic: string): Buffer {
  const normalized = mnemonic.trim().toLowerCase();
  if (!validateMnemonic(normalized)) {
    throw new Error('invalid BIP39 mnemonic');
  }
  return Buffer.from(mnemonicToEntropy(normalized), 'hex');
}

/**
 * Parses user-provided recovery key input, auto-detecting hex vs mnemonic format.
 *
 * @param input - Either a 64-character hex string or a 24-word BIP39 mnemonic.
 * @returns 32-byte Buffer.
 * @throws Error on invalid format, length, or checksum.
 */
export function parseRecoveryKeyInput(input: string): Buffer {
  const trimmed = input.trim();

  if (trimmed.includes(' ')) {
    return mnemonicToRecoveryKey(trimmed);
  }

  if (!/^[0-9a-fA-F]+$/.test(trimmed)) {
    throw new Error('invalid recovery key format: expected 64-character hex string or 24-word mnemonic');
  }

  if (trimmed.length !== HEX_KEY_LENGTH) {
    throw new Error(`invalid recovery key length: expected ${HEX_KEY_LENGTH} hex characters, got ${trimmed.length}`);
  }

  return Buffer.from(trimmed, 'hex');
}

/**
 * Generates a QR code PNG as a base64-encoded string.
 *
 * The QR code encodes a URI in the format:
 * `tkr-secrets://recover/{vaultName}?key={hex}`
 *
 * @param vaultName - Vault name for the recovery URI.
 * @param key - 32-byte recovery key.
 * @returns Base64-encoded PNG string.
 */
export async function generateRecoveryQR(vaultName: string, key: Buffer): Promise<string> {
  const uri = `tkr-secrets://recover/${encodeURIComponent(vaultName)}?key=${key.toString('hex')}`;
  const pngBuffer = await QRCode.toBuffer(uri, {
    width: 300,
    errorCorrectionLevel: 'M',
  });
  return pngBuffer.toString('base64');
}

/**
 * Assembles all recovery key presentation formats.
 *
 * @param vaultName - Vault name for QR code URI.
 * @param key - 32-byte recovery key.
 * @returns Object containing mnemonic, raw hex, and base64 QR PNG.
 */
export async function buildRecoveryKeyMaterial(
  vaultName: string,
  key: Buffer
): Promise<RecoveryKeyMaterial> {
  const mnemonic = recoveryKeyToMnemonic(key);
  const raw = key.toString('hex');
  const qr = await generateRecoveryQR(vaultName, key);
  return { mnemonic, raw, qr };
}

/**
 * Builds the `.tkr-recovery` file content as a JSON string.
 *
 * @param vaultName - Name of the vault this recovery key belongs to.
 * @param key - 32-byte recovery key.
 * @returns Pretty-printed JSON string with vault, recoveryKey, mnemonic, and createdAt fields.
 */
export function buildRecoveryFile(vaultName: string, key: Buffer): string {
  const content = {
    vault: vaultName,
    recoveryKey: key.toString('hex'),
    mnemonic: recoveryKeyToMnemonic(key),
    createdAt: new Date().toISOString(),
  };
  return JSON.stringify(content, null, 2);
}
