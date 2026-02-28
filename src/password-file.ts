/**
 * Password file operations for "remember password" functionality.
 * Stores the master password on disk so the store can auto-unlock on restart.
 */

import { existsSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

const DEFAULT_PATH = '~/.config/tkr-agent/.secrets-password';

/** Resolves the password file path, expanding ~ to home directory. */
export function resolvePasswordFilePath(override?: string): string {
  const raw = override ?? process.env['TKR_AGENT_SECRETS_PASSWORD_FILE'] ?? DEFAULT_PATH;
  if (raw.startsWith('~/')) {
    const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp';
    return `${home}${raw.slice(1)}`;
  }
  return raw;
}

/** Reads the stored password, or null if the file doesn't exist. */
export async function readPasswordFile(path: string): Promise<string | null> {
  const file = Bun.file(path);
  if (!await file.exists()) return null;
  const content = await file.text();
  return content.trim() || null;
}

/** Writes a password to the file, creating parent directories as needed. */
export async function writePasswordFile(path: string, password: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, password, { mode: 0o600 });
}

/** Deletes the password file if it exists. */
export function deletePasswordFile(path: string): void {
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

/** Checks whether a password file exists and is non-empty. */
export async function isPasswordRemembered(path: string): Promise<boolean> {
  const pw = await readPasswordFile(path);
  return pw !== null;
}
